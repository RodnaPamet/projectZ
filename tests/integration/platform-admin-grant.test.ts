import { randomUUID } from 'node:crypto';

import { prismaTestClient, resetDatabase } from '../helpers/db';
import { asAppSuperuser, asAppUser } from '../helpers/rls';

/**
 * THE PLATFORM-ADMIN GUARANTEES LIVE IN POSTGRES, SO THEY ARE TESTED IN POSTGRES.
 *
 * Every assertion here is about a trigger, a CHECK constraint or a policy. None
 * of it can be proved by the guardrail suite: `rls-policy-shape.test.ts:40-55`
 * records the measurement that a migration which DISABLED RLS and dropped its
 * policies passed all 38 guardrail suites. A text scan cannot tell a policy
 * that exists from one that merely once did.
 *
 * ═══ WHY THE ENFORCEMENT IS TRIGGERS AND NOT A ROLE ═══
 *
 * `DATABASE_URL` connects as `playerz`, which is `rolsuper=true` AND
 * `rolbypassrls=true` — verified against the cluster. Bindings issue
 * `SET LOCAL ROLE app_user` so isolation holds INSIDE one, but a guarantee
 * resting on a Postgres role is not a guarantee this repo currently has: P24
 * created `playerz_app LOGIN NOINHERIT` to fix that and was never adopted.
 *
 * Triggers fire for the table owner and the superuser alike. That is the whole
 * reason the design chose them, and it is why these tests run as the superuser
 * path and still expect refusal.
 */

const CAP = 'TENANT_READ';

describe('platform admin grants and audit (database-enforced)', () => {
  const db = prismaTestClient();

  /** Two distinct users — every grant is two-party by construction. */
  let holder: string;
  let granter: string;

  beforeEach(async () => {
    await resetDatabase(db);
    holder = `cadmin${randomUUID().replace(/-/g, '').slice(0, 18)}`;
    granter = `cgrant${randomUUID().replace(/-/g, '').slice(0, 18)}`;
    await asAppSuperuser(db, async (tx) => {
      await tx.$executeRawUnsafe(
        `INSERT INTO app_user (id, email, "createdAt", "updatedAt")
         VALUES ($1, $2, now(), now()), ($3, $4, now(), now())`,
        holder,
        `${holder}@test.invalid`,
        granter,
        `${granter}@test.invalid`,
      );
    });
  });

  /** Insert a grant, returning the error message if Postgres refused it. */
  async function grant(
    over: Partial<{
      userId: string;
      grantedByUserId: string;
      reason: string;
      capabilities: string[];
      expiresIn: string;
    }> = {},
  ): Promise<{ ok: boolean; error?: string }> {
    const caps = over.capabilities ?? [CAP];
    try {
      await asAppSuperuser(db, (tx) =>
        tx.$executeRawUnsafe(
          `INSERT INTO platform_admin_grant
             (id, "userId", "grantedByUserId", reason, capabilities, "expiresAt")
           VALUES ($1, $2, $3, $4, $5::"PlatformCapability"[], now() + $6::interval)`,
          `g${randomUUID().replace(/-/g, '').slice(0, 20)}`,
          over.userId ?? holder,
          over.grantedByUserId ?? granter,
          over.reason ?? 'incident response rota',
          `{${caps.join(',')}}`,
          over.expiresIn ?? '30 days',
        ),
      );
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  describe('what a grant may not be', () => {
    it('accepts a well-formed grant', async () => {
      // The positive control. Without it every refusal below could be the
      // insert failing for an unrelated reason.
      await expect(grant()).resolves.toMatchObject({ ok: true });
    });

    it('refuses a self-grant', async () => {
      // This is what makes the first grant two-party, and therefore what makes
      // "no in-app grant route" a real bound rather than a convention: a
      // compromised session cannot bootstrap a peer even with database access.
      const r = await grant({ grantedByUserId: holder });
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/no_self_grant/);
    });

    it('refuses an expiry beyond 90 days', async () => {
      // "Admin for ever" must not be expressible. A nullable or uncapped
      // expiry means grants ARE permanent in practice, because nobody revisits.
      const r = await grant({ expiresIn: '365 days' });
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/expiry_cap/);
    });

    it('refuses an empty capability list', async () => {
      // Regression test for a bug measured in this migration: the obvious
      // spelling `array_length(capabilities, 1) >= 1` returns NULL for an empty
      // array, `NULL >= 1` is NULL, and a CHECK treats NULL as SATISFIED. The
      // constraint read correctly and accepted every empty array. It is
      // `cardinality()` now, and this is the test that would have caught it.
      const r = await grant({ capabilities: [] });
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/capabilities_nonempty/);
    });

    it('refuses NULL capabilities, which the CHECK alone did not', async () => {
      // P31's second NULL hole, in the same constraint as the first.
      //
      // `cardinality(NULL)` is NULL and a CHECK treats NULL as SATISFIED — the
      // identical mechanism to the `array_length` bug fixed one line above,
      // caught for the empty array and missed for NULL itself. The column was
      // never declared NOT NULL either, because Prisma cannot express a nullable
      // scalar list, so the hand-written DDL omitted it AND `prisma migrate diff`
      // reported zero drift. Neither the constraint nor the drift check could see
      // it.
      //
      // Measured before P32: accepted, and then it occupied the one-live-grant
      // slot and BLOCKED a legitimate grant for that user. Never an escalation —
      // `liveCapabilities` throws on null and the resolver's catch returns no
      // authority — but a denial of service on the grant path.
      let error: string | undefined;
      try {
        await asAppSuperuser(db, (tx) =>
          tx.$executeRawUnsafe(
            `INSERT INTO platform_admin_grant
               (id,"userId","grantedByUserId",reason,capabilities,"expiresAt")
             VALUES ($1,$2,$3,'a grant with null capabilities',NULL, now() + interval '5 days')`,
            `g${randomUUID().replace(/-/g, '').slice(0, 20)}`,
            holder,
            granter,
          ),
        );
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
      }

      expect(error).toMatch(/null value in column "capabilities"|not-null constraint/i);
    });

    it('refuses a grant with no stated reason', async () => {
      const r = await grant({ reason: 'why' });
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/reason_stated/);
    });

    it('refuses a second live grant for the same person', async () => {
      // Overlapping live grants make "what could this person do?" unanswerable.
      await expect(grant()).resolves.toMatchObject({ ok: true });
      const second = await grant({ capabilities: ['AUDIT_READ'] });
      expect(second.ok).toBe(false);
      expect(second.error).toMatch(/one_live_idx/);
    });
  });

  describe('a grant is insert plus at most one revocation', () => {
    async function liveGrantId(): Promise<string> {
      await grant();
      const rows = await asAppSuperuser(db, (tx) =>
        tx.$queryRawUnsafe<{ id: string }[]>(
          `SELECT id FROM platform_admin_grant WHERE "userId" = $1`,
          holder,
        ),
      );
      return rows[0]!.id;
    }

    const attempt = async (sql: string, ...args: unknown[]) => {
      try {
        await asAppSuperuser(db, (tx) => tx.$executeRawUnsafe(sql, ...args));
        return { ok: true as const };
      } catch (e) {
        return { ok: false as const, error: e instanceof Error ? e.message : String(e) };
      }
    };

    it('never deletes a grant', async () => {
      const id = await liveGrantId();
      const r = await attempt(`DELETE FROM platform_admin_grant WHERE id = $1`, id);
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/never deleted/i);
    });

    it('refuses to widen expiresAt', async () => {
      // Without the trigger, expiresAt is advisory: the 90-day CHECK is
      // relative to grantedAt, so pushing it forward still satisfies it.
      const id = await liveGrantId();
      const r = await attempt(
        `UPDATE platform_admin_grant SET "expiresAt" = now() + interval '89 days' WHERE id = $1`,
        id,
      );
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/immutable except for revocation/i);
    });

    it('refuses to widen capabilities', async () => {
      // The escalation this prevents: a TENANT_READ grant quietly becoming a
      // TENANT_SUSPEND one without a new grant, a new reason, or a new granter.
      const id = await liveGrantId();
      const r = await attempt(
        `UPDATE platform_admin_grant
           SET capabilities = ARRAY['TENANT_READ','TENANT_SUSPEND']::"PlatformCapability"[]
         WHERE id = $1`,
        id,
      );
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/immutable except for revocation/i);
    });

    it('accepts a first revocation and refuses a second amendment', async () => {
      const id = await liveGrantId();

      const first = await attempt(
        `UPDATE platform_admin_grant
           SET "revokedAt" = now(), "revokedByUserId" = $2, "revokeReason" = 'rota ended here'
         WHERE id = $1`,
        id,
        granter,
      );
      expect(first.ok).toBe(true);

      const second = await attempt(
        `UPDATE platform_admin_grant SET "revokeReason" = 'a different reason' WHERE id = $1`,
        id,
      );
      expect(second.ok).toBe(false);
      expect(second.error).toMatch(/already revoked/i);
    });

    it('frees the live slot once revoked, so a grant can be renewed', async () => {
      // The partial unique index cannot mention expiry (an index predicate must
      // be IMMUTABLE and now() is not), so renewal is revoke-then-grant. This
      // asserts that path actually works — otherwise the index would be a
      // permanent lockout dressed as hygiene.
      const id = await liveGrantId();
      await attempt(
        `UPDATE platform_admin_grant
           SET "revokedAt" = now(), "revokedByUserId" = $2, "revokeReason" = 'renewing the rota'
         WHERE id = $1`,
        id,
        granter,
      );

      await expect(grant()).resolves.toMatchObject({ ok: true });
    });
  });

  describe('the audit row cannot be forged, misattributed or omitted', () => {
    async function insertAudit(
      actorUserId: string,
      bindTo: string | null,
    ): Promise<{ ok: boolean; error?: string }> {
      try {
        await asAppSuperuser(db, async (tx) => {
          if (bindTo !== null) {
            await tx.$executeRawUnsafe(
              `SELECT set_config('app.platform_admin_id', $1, true)`,
              bindTo,
            );
          }
          await tx.$executeRawUnsafe(
            `INSERT INTO platform_audit_entry
               (id, "actorUserId", "grantId", capability, action, reason)
             VALUES ($1, $2, 'g-any', $3::"PlatformCapability", 'TENANT_READ', 'support ticket 1')`,
            `a${randomUUID().replace(/-/g, '').slice(0, 20)}`,
            actorUserId,
            CAP,
          );
        });
        return { ok: true };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    }

    it('refuses an insert with no app.platform_admin_id on the transaction', async () => {
      // This is the load-bearing one. It means a platform audit row cannot be
      // written outside runAsPlatformAdmin — so the audit cannot be SKIPPED by
      // a caller who forgot, which is the usual way audit trails fail.
      const r = await insertAudit(holder, null);
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/requires app\.platform_admin_id/);
    });

    it('refuses an insert attributed to somebody else', async () => {
      // Without this, an admin could log their own cross-club read under a
      // colleague's name.
      const r = await insertAudit(holder, granter);
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/attribution mismatch/);
    });

    it('accepts an insert whose actor matches the bound admin', async () => {
      await expect(insertAudit(holder, holder)).resolves.toMatchObject({ ok: true });
    });

    it('refuses UPDATE and DELETE on an audit row', async () => {
      await insertAudit(holder, holder);

      for (const sql of [
        `UPDATE platform_audit_entry SET reason = 'rewritten'`,
        `DELETE FROM platform_audit_entry`,
      ]) {
        let error: string | undefined;
        try {
          await asAppSuperuser(db, (tx) => tx.$executeRawUnsafe(sql));
        } catch (e) {
          error = e instanceof Error ? e.message : String(e);
        }
        expect(error).toMatch(/APPEND-ONLY/);
      }
    });
  });

  describe('both tables deny app_user outright', () => {
    it('app_user cannot read grants', async () => {
      // app_user holds all four DML verbs on every table from P03, so the
      // deny-all policy plus the REVOKE is what actually stops it. A signed-in
      // member of any club must not be able to enumerate who has platform
      // authority — that is a target list.
      await grant();

      let denied = false;
      try {
        const rows = await asAppUser(db, 'some-tenant', (tx) =>
          tx.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*) AS n FROM platform_admin_grant`),
        );
        // Either refused outright, or visible as zero rows. Both are correct;
        // a non-zero count is not.
        denied = Number(rows[0]!.n) === 0;
      } catch {
        denied = true;
      }

      expect(denied).toBe(true);
    });

    it('app_user cannot forge a grant', async () => {
      let refused = false;
      try {
        await asAppUser(db, 'some-tenant', (tx) =>
          tx.$executeRawUnsafe(
            `INSERT INTO platform_admin_grant
               (id, "userId", "grantedByUserId", reason, capabilities, "expiresAt")
             VALUES ('forged', $1, $2, 'forged by app_user', ARRAY['TENANT_SUSPEND']::"PlatformCapability"[], now() + interval '1 day')`,
            holder,
            granter,
          ),
        );
      } catch {
        refused = true;
      }

      expect(refused).toBe(true);
    });
  });
});
