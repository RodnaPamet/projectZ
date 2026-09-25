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
 *   tsx scripts/grant-platform-admin.ts --list
 *
 * `--list` answers "who holds cross-club authority right now", which the audit
 * table cannot: that records ACTIONS, and reconstructing current state from a
 * log of grants and revocations is the arithmetic nobody should do at 03:00.
 *
 * Every flag is mandatory and nothing has a default. A default expiry would be
 * the expiry everybody uses, and a default reason would be no reason at all.
 */

const url = process.env.DIRECT_DATABASE_URL ?? process.env.DATABASE_URL;
if (!url) {
  throw new Error(
    'Neither DIRECT_DATABASE_URL nor DATABASE_URL is set. Granting platform authority\n' +
      'needs the OWNER connection: platform_admin_grant denies app_user, and after P24\n' +
      'the runtime role cannot write tables at all.',
  );
}

// ═══ THE FALLBACK IS FOR LOCAL DEV, AND IT SAYS SO OUT LOUD ═══
//
// Locally both URLs are the owner, so falling back is convenient and harmless.
// In any environment that has adopted P24 it is neither: DATABASE_URL names
// `playerz_app`, which owns no table and does not inherit its memberships — so
// the insert fails with `permission denied for table platform_admin_grant`.
//
// That error is technically accurate and completely unhelpful at 03:00. It looks
// like the grant table is misconfigured rather than like the wrong credential
// was used. One line of warning now beats ten minutes of reading RLS policies.
if (!process.env.DIRECT_DATABASE_URL) {
  console.warn(
    '\n⚠ DIRECT_DATABASE_URL is unset; falling back to DATABASE_URL.\n' +
      '  That is fine locally, where both name the owner. If this is a deployed\n' +
      '  environment, DATABASE_URL names playerz_app — which cannot write tables —\n' +
      '  and the grant below will fail with "permission denied for table\n' +
      '  platform_admin_grant". Set DIRECT_DATABASE_URL to the owner connection.\n',
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
      list: { type: 'boolean' },
    },
  });

  // ═══ --list FIRST: IT WRITES NOTHING AND NEEDS NOTHING ═══
  //
  // Placed before the --granted-by and --reason checks because reading who holds
  // authority is not an act that needs a justification or a second party.
  //
  // The runbook could already query platform_audit_entry, but that shows ACTIONS
  // — every grant and revocation ever. The question somebody actually has at
  // 03:00 is "who can reach our customers' data right now", and reconstructing
  // that from a log of mutations is exactly the arithmetic nobody should be doing
  // at that hour.
  if (values.list) {
    const rows = await prisma.platformAdminGrant.findMany({
      where: { revokedAt: null },
      select: {
        id: true,
        userId: true,
        capabilities: true,
        grantedAt: true,
        expiresAt: true,
        reason: true,
      },
      orderBy: { expiresAt: 'asc' },
    });

    if (rows.length === 0) {
      console.log('\nNo live platform grants. Nobody holds cross-club authority.\n');
      return;
    }

    // Resolve ids to emails: an id is not who you page.
    const users = await prisma.$queryRawUnsafe<{ id: string; email: string }[]>(
      `SELECT id, email FROM app_user WHERE id = ANY($1::text[])`,
      rows.map((r) => r.userId),
    );
    const emailOf = new Map(users.map((u) => [u.id, u.email]));

    const now = Date.now();
    console.log(`\n${rows.length} live platform grant(s), soonest to expire first:\n`);
    for (const r of rows) {
      const hours = (r.expiresAt.getTime() - now) / 36e5;
      // A lapsed-but-unrevoked grant is the state the runbook devotes a section
      // to: the holder is locked out AND the row still occupies their one live
      // slot, so a renewal is refused until somebody revokes it. It must not read
      // as merely "expiring soon".
      const state =
        hours <= 0
          ? `LAPSED ${Math.abs(hours / 24).toFixed(1)}d ago — still holding the live slot, revoke it before reissuing`
          : hours < 48
            ? `expires in ${hours.toFixed(1)}h`
            : `expires in ${(hours / 24).toFixed(1)}d`;

      console.log(`  ${emailOf.get(r.userId) ?? r.userId}`);
      console.log(`    ${r.capabilities.join(', ')}`);
      console.log(`    ${state}  (${r.expiresAt.toISOString()})`);
      console.log(`    granted ${r.grantedAt.toISOString().slice(0, 10)} — ${r.reason}`);
      console.log(`    grant id: ${r.id}\n`);
    }
    return;
  }

  const grantedByEmail = values['granted-by'];
  const reason = values.reason;

  if (!grantedByEmail) fail('--granted-by is required. A grant with no issuer answers nothing.');
  if (!reason) fail('--reason is required.');

  // ═══ THE DATABASE CHECKS `reason`, NOT `revokeReason` ═══
  //
  // `platform_admin_grant_reason_stated` covers the grant's reason only. The
  // revocation reason has no CHECK at all, so `--revoke … --reason "x"` was
  // accepted while this script claimed twelve characters were enforced — and
  // the runbook's own example, "rota ended", is ten.
  //
  // Validated here for both paths, so the claim is true again.
  const MIN_REASON = 12;
  if (reason.trim().length < MIN_REASON) {
    fail(
      `--reason must be at least ${MIN_REASON} characters (got ${reason.trim().length}).\n` +
        `  It lands in an append-only table and is the only thing that makes the row\n` +
        `  answerable months later. For a grant the database enforces this too; for a\n` +
        `  REVOCATION it does not, so this check is the only one.`,
    );
  }

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

  // Empty segments are dropped, not rejected. `--capabilities TENANT_READ,` and
  // `TENANT_READ,,AUDIT_READ` are trailing-comma typos — trivially easy when
  // copying a line out of the runbook — and both used to fail with
  // `Unknown capability: ` followed by nothing at all, which tells the operator
  // precisely nothing about what to change.
  //
  // This is forgiving about punctuation and strict about NAMES: a real typo like
  // `AUDIT_RAED` is still an unknown capability and still refused.
  const caps = capsRaw
    .split(',')
    .map((c) => c.trim().toUpperCase())
    .filter((c) => c.length > 0);

  if (caps.length === 0) {
    fail(
      `--capabilities contained no capability names (got ${JSON.stringify(capsRaw)}).\n` +
        `  Valid: ${Object.values(PlatformCapability).join(', ')}`,
    );
  }

  const unknown = caps.filter((c) => !(c in PlatformCapability));
  if (unknown.length > 0) {
    fail(
      `Unknown capabilit${unknown.length === 1 ? 'y' : 'ies'}: ${unknown.join(', ')}\n` +
        `  Valid: ${Object.values(PlatformCapability).join(', ')}`,
    );
  }

  // ═══ A BARE DATE MEANS THE END OF THAT DAY, NOT THE START ═══
  //
  // `new Date('2026-09-26')` is 2026-09-26T00:00:00.000Z. So the runbook's own
  // incident recipe — `--expires <tomorrow>` — produced a grant that died at
  // midnight UTC: issued at 19:37 it lasted 4h22m, issued at 23:30 it lasted
  // thirty minutes. Measured, both.
  //
  // Worse in a positive offset. `--expires 2026-11-01` from Europe/Sofia (UTC+2)
  // expired at 02:00 local on the 1st — dead for the whole working day it was
  // meant to cover, which is exactly the "lapses at 03:00 during an outage"
  // failure this feature exists to prevent.
  //
  // And `--expires <today>` was REFUSED as being in the past, so there was no way
  // to say "expires at the end of the day I named" at all.
  //
  // A full ISO timestamp is still honoured verbatim for anyone who wants a
  // precise instant.
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(expires.trim());
  const expiresAt = dateOnly ? new Date(`${expires.trim()}T23:59:59.999Z`) : new Date(expires);
  if (Number.isNaN(expiresAt.getTime())) fail(`--expires is not a date I can parse: ${expires}`);

  // An accidentally tiny window is indistinguishable from an intended one in the
  // output, and the warn job runs DAILY — so it cannot warn about a grant that
  // lives for an hour. Say so at issue time instead.
  const hours = (expiresAt.getTime() - Date.now()) / 36e5;
  if (hours > 0 && hours < 2) {
    console.warn(
      `\n⚠ That grant lasts ${hours.toFixed(1)} hours. The expiry warning job runs daily,\n` +
        `  so nothing will warn before it lapses. If you meant the end of a day, pass\n` +
        `  a bare date (YYYY-MM-DD); if you meant this, carry on.\n`,
    );
  }

  const holderId = await userIdByEmail(prisma, userEmail, '--user');
  const granterId = await userIdByEmail(prisma, grantedByEmail, '--granted-by');

  // The grant and its audit row in ONE transaction, attributed to the GRANTER.
  // A grant that committed without its audit row would be authority nobody
  // issued, which is the state this whole design exists to make impossible.
  // ═══ PRINTED AFTER THE AWAIT, NOT INSIDE THE CALLBACK ═══
  //
  // The success block used to be the last thing INSIDE the transaction, so it
  // reached stdout before COMMIT. A commit failure — Prisma's 5s interactive
  // transaction timeout (P2028), a dropped connection on a pooled database —
  // printed the full "✓ Granted … grant id: …" and THEN an error, exit 1, with no
  // row written. An operator scanning for the tick mark concludes authority was
  // issued when nothing was.
  //
  // The revoke path already printed after its await. The two halves of the same
  // CLI disagreed, and this half was the wrong one.
  const issued = await prisma.$transaction(async (tx) => {
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

    return grantId;
  });

  console.log(`\n✓ Granted platform authority to ${userEmail}`);
  console.log(`  capabilities: ${caps.join(', ')}`);
  console.log(
    `  expires:      ${expiresAt.toISOString()}${dateOnly ? '  (end of the day you named)' : ''}`,
  );
  console.log(`  granted by:   ${grantedByEmail}`);
  console.log(`  reason:       ${reason}`);
  console.log(`  grant id:     ${issued}\n`);
  console.log(`  It expires on its own. Nobody has to remember to remove it — which`);
  console.log(`  is the point, and is why there is a 90-day cap in the database.\n`);
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
