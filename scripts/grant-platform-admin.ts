import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';

import { PrismaPg } from '@prisma/adapter-pg';
import { PlatformCapability, PrismaClient } from '@prisma/client';

/**
 * Issue or revoke platform authority. THE ONLY WRITER.
 *
 * ═══ WHY THERE IS NO API ROUTE ═══
 *
 * The owner's decision, and the right one under "assume the admin account will
 * be compromised". With an in-app grant path, a stolen session mints a second
 * admin and survives revocation of the first — the compromise becomes
 * persistent and self-healing. Without one, a stolen session is bounded by the
 * single grant it already holds and dies when that grant is revoked or expires.
 *
 * The cost is real and was accepted: every new admin needs somebody with
 * deploy-level database access, at whatever hour.
 *
 * ═══ WHY IT CONNECTS VIA DIRECT_DATABASE_URL ═══
 *
 * `platform_admin_grant` denies `app_user` outright, and after P24 the runtime
 * role cannot write tables at all. This needs the owner connection — which is
 * strictly MORE authority than any grant it issues, and is the real bar for
 * platform access.
 *
 * ═══ WHAT THE DATABASE ENFORCES, NOT THIS SCRIPT ═══
 *
 *   no self-grant            CHECK — so the first grant is two-party and
 *                            nobody can bootstrap themselves
 *   expiry <= 90 days        CHECK, relative to grantedAt
 *   reason >= 12 chars       CHECK
 *   at least one capability  CHECK (cardinality, not array_length — see P31)
 *   one live grant per user  partial unique index
 *   immutability             trigger: insert plus at most one revocation
 *
 * This script therefore does not re-implement those rules. It fails with the
 * database's own message, which is the one that will still be true after
 * somebody edits this file.
 *
 * ═══ USAGE ═══
 *
 *   tsx scripts/grant-platform-admin.ts \
 *     --user alice@playerz.bg \
 *     --granted-by bob@playerz.bg \
 *     --capabilities TENANT_READ,AUDIT_READ \
 *     --expires 2026-11-01 \
 *     --reason "incident response rota Q4"
 *
 *   tsx scripts/grant-platform-admin.ts \
 *     --revoke alice@playerz.bg \
 *     --granted-by bob@playerz.bg \
 *     --reason "rota ended"
 *
 * Every flag is mandatory and nothing has a default. A default expiry would be
 * the expiry everybody uses, and a default reason would be no reason at all.
 */

const url = process.env.DIRECT_DATABASE_URL ?? process.env.DATABASE_URL;
if (!url) {
  throw new Error(
    'DIRECT_DATABASE_URL is unset. Granting platform authority needs the OWNER\n' +
      'connection: platform_admin_grant denies app_user, and after P24 the runtime\n' +
      'role cannot write tables at all.',
  );
}

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });

function fail(message: string): never {
  console.error(`\n✖ ${message}\n`);
  process.exit(1);
}

/** Resolve an email to a real User row, so the person can be asked later. */
async function userIdByEmail(db: PrismaClient, email: string, label: string): Promise<string> {
  const rows = await db.$queryRawUnsafe<{ id: string }[]>(
    `SELECT id FROM app_user WHERE email = $1`,
    email,
  );
  if (rows.length === 0) {
    fail(
      `No user with email ${email} (${label}).\n` +
        `  Both parties must be real accounts — the granter especially, because the\n` +
        `  audit trail is only worth something if there is a person to ask about it.`,
    );
  }
  return rows[0]!.id;
}

async function main() {
  const { values } = parseArgs({
    options: {
      user: { type: 'string' },
      'granted-by': { type: 'string' },
      capabilities: { type: 'string' },
      expires: { type: 'string' },
      reason: { type: 'string' },
      revoke: { type: 'string' },
    },
  });

  const grantedByEmail = values['granted-by'];
  const reason = values.reason;

  if (!grantedByEmail) fail('--granted-by is required. A grant with no issuer answers nothing.');
  if (!reason) fail('--reason is required, and the database enforces at least 12 characters.');

  // ── Revocation ────────────────────────────────────────────────────
  if (values.revoke) {
    const holderId = await userIdByEmail(prisma, values.revoke, '--revoke');
    const revokerId = await userIdByEmail(prisma, grantedByEmail, '--granted-by');

    // Revocation is audited too. The grant row itself records who revoked it
    // and why, but a reader asking "what happened on the platform?" queries the
    // audit table — and a log that shows every grant and no revocation tells the
    // wrong story: it looks like authority only ever accumulates.
    const revoked = await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL ROLE app_superuser`);

      // The TYPED client, not $queryRaw. A raw query returns a Postgres enum
      // array as the string "{TENANT_READ}", so `capabilities[0]` was "{" —
      // which is how this was found: the audit insert failed with
      // `invalid input value for enum "PlatformCapability": "{"`.
      //
      // The same mistake in src/lib/auth/platform-admin.ts was quieter and much
      // worse: it put a string where an array was typed, and an authorisation
      // check then did substring matching.
      const grant = await tx.platformAdminGrant.findFirst({
        where: { userId: holderId, revokedAt: null },
        select: { id: true, capabilities: true },
      });
      if (!grant) return null;

      await tx.$executeRawUnsafe(
        `UPDATE platform_admin_grant
            SET "revokedAt" = now(), "revokedByUserId" = $2, "revokeReason" = $3
          WHERE id = $1`,
        grant.id,
        revokerId,
        reason,
      );

      await tx.$executeRawUnsafe(`SELECT set_config('app.platform_admin_id', $1, true)`, revokerId);
      await tx.$executeRawUnsafe(
        `INSERT INTO platform_audit_entry
           (id, "actorUserId", "grantId", capability, action, entity, "entityId", reason, "detailsJson")
         VALUES ($1, $2, $3, $4::"PlatformCapability", 'PLATFORM_GRANT_REVOKED',
                 'PlatformAdminGrant', $3, $5, $6::jsonb)`,
        `a${randomUUID().replace(/-/g, '').slice(0, 20)}`,
        revokerId,
        grant.id,
        grant.capabilities[0],
        reason,
        JSON.stringify({ holder: values.revoke, revokedCapabilities: grant.capabilities }),
      );

      return grant.id;
    });

    if (!revoked) {
      fail(`${values.revoke} holds no live grant. Nothing to revoke.`);
    }

    console.log(`\n✓ Revoked platform authority for ${values.revoke}`);
    console.log(`  by ${grantedByEmail} — ${reason}`);
    console.log(`  grant id: ${revoked}`);
    console.log(`\n  Takes effect on their next request: the grant is re-read from the`);
    console.log(`  database every time, never cached in a token.\n`);
    return;
  }

  // ── Issue ─────────────────────────────────────────────────────────
  const userEmail = values.user;
  const expires = values.expires;
  const capsRaw = values.capabilities;

  if (!userEmail) fail('--user is required (the email of the person receiving authority).');
  if (!expires) fail('--expires is required. There is no default: 90 days is a CAP, not a value.');
  if (!capsRaw) {
    fail(
      `--capabilities is required. One or more of: ${Object.values(PlatformCapability).join(', ')}\n` +
        `  TENANT_SUSPEND is declared but REFUSED at the binding — cross-club writes need a\n` +
        `  second factor and there is none. Granting it buys nothing today.`,
    );
  }

  const caps = capsRaw.split(',').map((c) => c.trim().toUpperCase());
  const unknown = caps.filter((c) => !(c in PlatformCapability));
  if (unknown.length > 0) {
    fail(
      `Unknown capabilit${unknown.length === 1 ? 'y' : 'ies'}: ${unknown.join(', ')}\n` +
        `  Valid: ${Object.values(PlatformCapability).join(', ')}`,
    );
  }

  const expiresAt = new Date(expires);
  if (Number.isNaN(expiresAt.getTime())) fail(`--expires is not a date I can parse: ${expires}`);

  const holderId = await userIdByEmail(prisma, userEmail, '--user');
  const granterId = await userIdByEmail(prisma, grantedByEmail, '--granted-by');

  // The grant and its audit row in ONE transaction, attributed to the GRANTER.
  // A grant that committed without its audit row would be authority nobody
  // issued, which is the state this whole design exists to make impossible.
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL ROLE app_superuser`);

    const grantId = `cg${randomUUID().replace(/-/g, '').slice(0, 20)}`;

    await tx.$executeRawUnsafe(
      `INSERT INTO platform_admin_grant
         (id, "userId", "grantedByUserId", reason, capabilities, "expiresAt")
       VALUES ($1, $2, $3, $4, $5::"PlatformCapability"[], $6)`,
      grantId,
      holderId,
      granterId,
      reason,
      `{${caps.join(',')}}`,
      expiresAt,
    );

    // The GUC names the granter, because issuing a grant is the granter's act.
    // The attribution trigger refuses any mismatch.
    await tx.$executeRawUnsafe(`SELECT set_config('app.platform_admin_id', $1, true)`, granterId);
    await tx.$executeRawUnsafe(
      `INSERT INTO platform_audit_entry
         (id, "actorUserId", "grantId", capability, action, entity, "entityId", reason, "detailsJson")
       VALUES ($1, $2, $3, $4::"PlatformCapability", 'PLATFORM_GRANT_ISSUED',
               'PlatformAdminGrant', $3, $5, $6::jsonb)`,
      `a${randomUUID().replace(/-/g, '').slice(0, 20)}`,
      granterId,
      grantId,
      caps[0],
      reason,
      JSON.stringify({ holder: userEmail, capabilities: caps, expiresAt: expiresAt.toISOString() }),
    );

    console.log(`\n✓ Granted platform authority to ${userEmail}`);
    console.log(`  capabilities: ${caps.join(', ')}`);
    console.log(`  expires:      ${expiresAt.toISOString()}`);
    console.log(`  granted by:   ${grantedByEmail}`);
    console.log(`  reason:       ${reason}`);
    console.log(`  grant id:     ${grantId}\n`);
    console.log(`  It expires on its own. Nobody has to remember to remove it — which`);
    console.log(`  is the point, and is why there is a 90-day cap in the database.\n`);
  });
}

/**
 * What each database refusal means, in a sentence.
 *
 * The raw error is still printed — it is the one that stays true after somebody
 * edits this file. But `violates check constraint
 * "platform_admin_grant_no_self_grant"` is not much help to whoever is running
 * this at 03:00 during an incident, and this tool exists precisely for those
 * moments.
 */
const REFUSALS: Array<[RegExp, string]> = [
  [
    /no_self_grant/,
    'Nobody can grant platform authority to themselves. The first grant is two-party by ' +
      'design — ask a colleague to issue it, so there is always someone else who knows.',
  ],
  [
    /expiry_cap/,
    'A grant may last at most 90 days from now, and --expires must be in the future. ' +
      '"Admin for ever" is deliberately not expressible: nobody goes back to revoke, so ' +
      'expiry has to do that work unattended.',
  ],
  [
    /reason_stated/,
    'The reason must be at least 12 characters. It lands in an append-only table and is ' +
      'the only thing that makes the row answerable months later.',
  ],
  [
    /capabilities_nonempty/,
    'A grant needs at least one capability. An empty list is a confusing way to spell ' +
      '"revoked".',
  ],
  [
    /one_live_idx/,
    'That person already holds a live grant. Revoke it first (--revoke) and issue a new ' +
      'one: renewal is deliberately two steps, so overlapping grants cannot pile up and ' +
      'leave "what could this person do?" unanswerable.',
  ],
  [
    /immutable except for revocation|already revoked/,
    'A grant cannot be amended after it is issued — not its expiry, and especially not ' +
      'its capabilities. Issue a new grant instead.',
  ],
  [
    /attribution mismatch|requires app\.platform_admin_id/,
    'The audit row was refused by the database. This is a bug in this script, not in your ' +
      'command: every grant must be recorded against the person issuing it.',
  ],
];

main()
  .catch((e) => {
    const raw = e instanceof Error ? e.message : String(e);
    const explained = REFUSALS.find(([pattern]) => pattern.test(raw))?.[1];

    if (explained) {
      console.error(`\n✖ ${explained}\n`);
      console.error(`  The database said:\n  ${raw.split('\n').filter(Boolean).pop()}\n`);
    } else {
      console.error(`\n✖ ${raw}\n`);
    }
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
