import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

import { prismaTestClient, resetDatabase } from '../helpers/db';
import { asAppSuperuser } from '../helpers/rls';

/**
 * deploy/rollback/p72-park.sql leaves nothing of the four values P72 added
 * where the pre-P72 image reads, and p72-unpark.sql gives everything back
 * (#545, #450).
 *
 * The values sit in the two tables this product guards hardest: a platform
 * grant is immutable and the platform audit trail is append-only, both by
 * trigger. So this also pins that the scripts leave those triggers ON.
 */

const db = prismaTestClient();

function run(file: string): void {
  execFileSync('npx', ['prisma', 'db', 'execute', '--file', file], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

const id = (p: string) => `${p}${randomUUID().replace(/-/g, '').slice(0, 20)}`;

const state = async () => ({
  grants: await db.$queryRawUnsafe<Array<{ id: string; caps: string; revoked: boolean }>>(
    `SELECT id, array_to_string(capabilities::text[], ',') AS caps, "revokedAt" IS NOT NULL AS revoked
     FROM platform_admin_grant ORDER BY id`,
  ),
  audit: await db.$queryRawUnsafe<Array<{ id: string; capability: string; action: string }>>(
    `SELECT id, capability::text AS capability, action FROM platform_audit_entry ORDER BY id`,
  ),
  bell: await db.$queryRawUnsafe<Array<{ id: string; kind: string }>>(
    `SELECT id, kind::text AS kind FROM notification ORDER BY id`,
  ),
  outbox: await db.$queryRawUnsafe<Array<{ id: string; kind: string; category: string }>>(
    `SELECT id, kind::text AS kind, category FROM email_outbox ORDER BY id`,
  ),
});

const triggersOn = () =>
  db.$queryRawUnsafe<Array<{ tgname: string }>>(
    `SELECT tgname FROM pg_trigger
     WHERE tgname IN ('platform_admin_grant_immutable_trg', 'platform_audit_append_only_trg',
                      'platform_audit_attribution_trg')
       AND tgenabled = 'O'
     ORDER BY tgname`,
  );

describe('rolling back past P72', () => {
  let both: string;
  let only: string;
  let other: string;

  beforeEach(async () => {
    await resetDatabase(db);
    const [a, b, c, granter, coach] = [id('pa'), id('pb'), id('pc'), id('pg'), id('pk')];
    [both, only, other] = [id('g1'), id('g2'), id('g3')];
    await asAppSuperuser(db, async (tx) => {
      await tx.$executeRawUnsafe(
        `INSERT INTO app_user (id,email,"createdAt","updatedAt")
         SELECT x, x || '@test.invalid', now(), now() FROM unnest($1::text[]) x`,
        [a, b, c, granter, coach],
      );
      // One grant with the new capability among others, one with it alone,
      // one without it.
      for (const [gid, holder, caps] of [
        [both, a, '{TENANT_READ,COACH_APPROVE,REVIEW_MODERATE}'],
        [only, b, '{COACH_APPROVE}'],
        [other, c, '{CONTACT_READ}'],
      ] as const) {
        await tx.$executeRawUnsafe(
          `INSERT INTO platform_admin_grant
             (id,"userId","grantedByUserId",reason,capabilities,"grantedAt","expiresAt")
           VALUES ($1,$2,$3,'approving the pilot coaches',$4::"PlatformCapability"[],
                   now(), now() + interval '30 days')`,
          gid,
          holder,
          granter,
          caps,
        );
      }
      // The audit trail: written as runAsPlatformAdmin writes it, bound to the actor.
      for (const [actor, grantId, capability, action] of [
        [a, both, 'COACH_APPROVE', 'PLATFORM_COACH_APPLICATION_DECIDE'],
        [a, both, 'TENANT_READ', 'PLATFORM_TENANT_LIST'],
        [b, only, 'COACH_APPROVE', 'PLATFORM_COACH_CERTIFICATE_OPEN'],
      ] as const) {
        await tx.$executeRawUnsafe(`SELECT set_config('app.platform_admin_id', $1, true)`, actor);
        await tx.$executeRawUnsafe(
          `INSERT INTO platform_audit_entry
             (id,"actorUserId","grantId",capability,action,reason,"detailsJson")
           VALUES ($1,$2,$3,$4::"PlatformCapability",$5,'deciding a coach application','{}'::jsonb)`,
          id('au'),
          actor,
          grantId,
          capability,
          action,
        );
      }
      await tx.notification.createMany({
        data: [
          { userId: coach, kind: 'COACH_PROFILE_APPROVED', title: 't', body: 'b', dedupeKey: 'k1' },
          { userId: coach, kind: 'COACH_PROFILE_DECLINED', title: 't', body: 'b', dedupeKey: 'k2' },
          { userId: coach, kind: 'BOOKING_CONFIRMED', title: 't', body: 'b', dedupeKey: 'k3' },
        ],
      });
      await tx.emailOutbox.createMany({
        data: [
          {
            userId: coach,
            kind: 'COACH_PROFILE_APPROVED',
            category: 'account',
            dedupeKey: 'e1',
            locale: 'bg',
            subject: 's',
            text: 't',
          },
          {
            userId: null,
            kind: 'COACH_PROFILE_SUBMITTED',
            category: 'contact',
            dedupeKey: 'e2',
            locale: 'bg',
            subject: 's',
            text: 't',
          },
          {
            userId: coach,
            kind: 'BOOKING_CONFIRMED',
            category: 'confirmation',
            dedupeKey: 'e3',
            locale: 'bg',
            subject: 's',
            text: 't',
          },
        ],
      });
    });
  });

  it('parks every row of the four values, keeps the rest working, and unparks them whole', async () => {
    const before = await state();
    expect(before.grants.map((g) => g.caps)).toEqual(
      expect.arrayContaining(['TENANT_READ,COACH_APPROVE,REVIEW_MODERATE', 'COACH_APPROVE']),
    );

    run('deploy/rollback/p72-park.sql');
    // Twice: the second run must not replace the parked grant with the narrowed one.
    run('deploy/rollback/p72-park.sql');

    const parked = await state();
    // Nothing the previous image cannot read is left.
    expect(JSON.stringify(parked)).not.toMatch(/COACH_APPROVE|COACH_PROFILE_/);
    // The grant that carried other capabilities keeps them: its holder still works.
    expect(parked.grants).toEqual(
      [
        { id: both, caps: 'TENANT_READ,REVIEW_MODERATE', revoked: false },
        { id: other, caps: 'CONTACT_READ', revoked: false },
      ].sort((x, y) => x.id.localeCompare(y.id)),
    );
    // The rest of the trail, the bell and the outbox are where they were.
    expect(parked.audit.map((r) => r.action)).toEqual(['PLATFORM_TENANT_LIST']);
    expect(parked.bell.map((r) => r.kind)).toEqual(['BOOKING_CONFIRMED']);
    expect(parked.outbox.map((r) => r.kind)).toEqual(['BOOKING_CONFIRMED']);
    // And the audit rows are not lost: they sit in the park table, whole.
    const held = await db.$queryRawUnsafe<Array<{ n: number }>>(
      `SELECT count(*)::int AS n FROM p72_parked_platform_audit_entry`,
    );
    expect(held[0]!.n).toBe(2);

    expect((await triggersOn()).length).toBe(3);

    run('deploy/rollback/p72-unpark.sql');
    expect(await state()).toEqual(before);
    expect((await triggersOn()).length).toBe(3);
    // With nothing parked, a second unpark does nothing.
    run('deploy/rollback/p72-unpark.sql');
    expect(await state()).toEqual(before);
  });

  it('the scripts leave the grant immutable and the audit trail append-only', async () => {
    run('deploy/rollback/p72-park.sql');
    await expect(
      db.$executeRawUnsafe(
        `UPDATE platform_admin_grant SET capabilities = '{TENANT_READ}' WHERE id = $1`,
        both,
      ),
    ).rejects.toThrow(/immutable except for revocation/);
    await expect(db.$executeRawUnsafe(`DELETE FROM platform_audit_entry`)).rejects.toThrow(
      /APPEND-ONLY/,
    );

    run('deploy/rollback/p72-unpark.sql');
    await expect(
      db.$executeRawUnsafe(`DELETE FROM platform_admin_grant WHERE id = $1`, only),
    ).rejects.toThrow(/never deleted/);
    await expect(
      db.$executeRawUnsafe(`UPDATE platform_audit_entry SET reason = 'rewritten afterwards'`),
    ).rejects.toThrow(/APPEND-ONLY/);
  });

  it('a grant revoked while parked stays revoked, with the capabilities it held', async () => {
    run('deploy/rollback/p72-park.sql');
    await db.$executeRawUnsafe(
      `UPDATE platform_admin_grant
       SET "revokedAt" = now(), "revokedByUserId" = "grantedByUserId", "revokeReason" = 'left the team during the rollback'
       WHERE id = $1`,
      both,
    );
    run('deploy/rollback/p72-unpark.sql');
    expect((await state()).grants.find((g) => g.id === both)).toEqual({
      id: both,
      caps: 'TENANT_READ,COACH_APPROVE,REVIEW_MODERATE',
      revoked: true,
    });
  });
});
