import { randomUUID } from 'node:crypto';

import { POST } from '@/app/api/cron/warn-expiring-platform-grants/route';

import { prismaTestClient, resetDatabase } from '../helpers/db';
import { asAppSuperuser } from '../helpers/rls';

/**
 * THE EXPIRY WARNING, ACTUALLY RUN.
 *
 * It shipped in #174 having never been executed once — written, typechecked, and
 * never invoked. Which is precisely the failure it exists to prevent somebody
 * else suffering, and precisely the failure #145 records for the booking sweeper:
 * that route shipped in #119 and nothing called it for seventeen prompts.
 *
 * ═══ WHAT MATTERS MOST HERE ═══
 *
 * The `lapsed` branch. A grant past its expiry that nobody revoked is worse than
 * a simply-expired one: the holder is locked out AND the row still occupies the
 * one-live-grant slot, so a renewal is refused by the partial unique index until
 * somebody revokes it. That is the trap the runbook devotes a section to, and it
 * is reported separately for exactly that reason.
 */

function req(headers: Record<string, string> = {}): Request {
  return new Request('http://localhost/api/cron/warn-expiring-platform-grants', {
    method: 'POST',
    headers,
  });
}

// A fixture, not a credential: it is compared against process.env.CRON_SECRET,
// which this file sets and restores itself. Unlike the PEM-shaped fixture the
// scanner caught earlier today, the "secret" shape cannot be removed here — the
// route's whole job is comparing one — so this is the allowlist case rather than
// a value to rewrite.
const SECRET = 'test-cron-secret-value'; // pragma: allowlist secret

describe('warn-expiring-platform-grants', () => {
  const db = prismaTestClient();
  let holder: string;
  let granter: string;
  let savedSecret: string | undefined;

  beforeEach(async () => {
    await resetDatabase(db);
    savedSecret = process.env.CRON_SECRET;
    process.env.CRON_SECRET = SECRET;

    holder = `c${randomUUID().replace(/-/g, '').slice(0, 23)}`;
    granter = `c${randomUUID().replace(/-/g, '').slice(0, 23)}`;
    await asAppSuperuser(db, (tx) =>
      tx.$executeRawUnsafe(
        `INSERT INTO app_user (id,email,"createdAt","updatedAt")
         VALUES ($1,$2,now(),now()), ($3,$4,now(),now())`,
        holder,
        `${holder}@test.invalid`,
        granter,
        `${granter}@test.invalid`,
      ),
    );
  });

  afterEach(() => {
    if (savedSecret === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = savedSecret;
  });

  /**
   * Insert a grant expiring `days` from now; negative means already lapsed.
   *
   * ═══ grantedAt IS DERIVED FROM expiresAt, NOT CHOSEN ═══
   *
   * The constraint is
   * `CHECK (expiresAt > grantedAt AND expiresAt <= grantedAt + interval '90 days')`
   * — BOTH clauses. Expiry must be after issuance AND within 90 days of it.
   *
   * I got this wrong twice. First I backdated `grantedAt` one day for every case
   * and wrote a comment claiming the CHECK "caps how far expiry may be, not that
   * it must be in the future" — flatly untrue. Then I backdated it 100 days for
   * lapsed grants, which fails the OTHER clause: 100 days back permits expiry
   * only up to `now - 10 days`, so a grant lapsed 2 days ago is still outside.
   *
   * So it is now anchored to expiry rather than to now: issued exactly 30 days
   * before it expires. That satisfies both clauses for ANY `days`, positive or
   * negative, by construction rather than by arithmetic I keep fumbling.
   */
  async function grant(days: number, opts: { revoked?: boolean } = {}) {
    const id = `cg${randomUUID().replace(/-/g, '').slice(0, 20)}`;
    await asAppSuperuser(db, async (tx) => {
      await tx.$executeRawUnsafe(
        `INSERT INTO platform_admin_grant
           (id,"userId","grantedByUserId",reason,capabilities,"grantedAt","expiresAt")
         VALUES ($1,$2,$3,'incident response rota',
                 ARRAY['TENANT_READ']::"PlatformCapability"[],
                 now() + ($4 || ' days')::interval - interval '30 days',
                 now() + ($4 || ' days')::interval)`,
        id,
        holder,
        granter,
        String(days),
      );
      if (opts.revoked) {
        await tx.$executeRawUnsafe(
          `UPDATE platform_admin_grant SET "revokedAt"=now(), "revokedByUserId"=$2,
             "revokeReason"='revoked for the test' WHERE id=$1`,
          id,
          granter,
        );
      }
    });
    return id;
  }

  const body = async (r: Response) =>
    (await r.json()) as {
      expiringSoon: number;
      lapsed: number;
      truncated: boolean;
      warnWithinDays: number;
    };

  describe('authorisation, which is the whole security boundary', () => {
    it('refuses with 503 when CRON_SECRET is unset, never "unset means allow"', async () => {
      // That inversion — no credential configured, therefore no check — is how an
      // internal endpoint ends up open the day somebody forgets an env var.
      delete process.env.CRON_SECRET;

      const r = await POST(req({ 'x-cron-secret': SECRET }) as never);
      expect(r.status).toBe(503);
      expect((await r.json()).error.code).toBe('NOT_CONFIGURED');
    });

    it('refuses with 401 on a wrong secret', async () => {
      const r = await POST(req({ 'x-cron-secret': 'wrong-but-same-length' }) as never);
      expect(r.status).toBe(401);
    });

    it('refuses with 401 on no secret at all', async () => {
      const r = await POST(req() as never);
      expect(r.status).toBe(401);
    });

    it('accepts the secret as a Bearer token too', async () => {
      // Vercel Cron sends `Authorization: Bearer <secret>`; another scheduler may
      // use the header. Both work so the deployment is not locked to a provider —
      // and the ops/ sidecar uses the header form.
      const r = await POST(req({ authorization: `Bearer ${SECRET}` }) as never);
      expect(r.status).toBe(200);
    });

    it('does not distinguish "wrong secret" from "not configured" to the caller', async () => {
      // The operator finds the difference in the log, not the response.
      const wrong = await POST(req({ 'x-cron-secret': 'nope' }) as never);
      expect((await wrong.json()).error.message).not.toMatch(/configur/i);
    });
  });

  describe('what it reports', () => {
    it('reports nothing when there are no grants', async () => {
      const b = await body(await POST(req({ 'x-cron-secret': SECRET }) as never));
      expect(b).toMatchObject({ expiringSoon: 0, lapsed: 0, truncated: false, warnWithinDays: 7 });
    });

    it('ignores a grant comfortably outside the horizon', async () => {
      await grant(60);
      const b = await body(await POST(req({ 'x-cron-secret': SECRET }) as never));
      expect(b.expiringSoon).toBe(0);
      expect(b.lapsed).toBe(0);
    });

    it('warns about a grant inside the 7-day horizon', async () => {
      await grant(3);
      const b = await body(await POST(req({ 'x-cron-secret': SECRET }) as never));
      expect(b.expiringSoon).toBe(1);
      expect(b.lapsed).toBe(0);
    });

    it('reports a LAPSED grant separately — the runbook trap', async () => {
      // Expired and never revoked. The holder is locked out and the row still
      // holds the live slot, so a renewal is refused until somebody revokes it.
      // Counting this as merely "expiring soon" would bury the one case that
      // needs a different action.
      await grant(-2);
      const b = await body(await POST(req({ 'x-cron-secret': SECRET }) as never));
      expect(b.lapsed).toBe(1);
      expect(b.expiringSoon).toBe(0);
    });

    it('ignores a revoked grant even when its expiry is imminent', async () => {
      // Revoked is handled. Warning about it would be noise, and noise is how a
      // daily alert stops being read.
      await grant(1, { revoked: true });
      const b = await body(await POST(req({ 'x-cron-secret': SECRET }) as never));
      expect(b.expiringSoon).toBe(0);
      expect(b.lapsed).toBe(0);
    });

    it('does not report truncated on a normal run', async () => {
      // `truncated` exists so a capped scan is never mistaken for a complete one.
      // It must be false in the ordinary case or it means nothing.
      await grant(2);
      const b = await body(await POST(req({ 'x-cron-secret': SECRET }) as never));
      expect(b.truncated).toBe(false);
    });

    it('changes nothing — it warns and never extends', async () => {
      // An automatic renewal would defeat the 90-day cap entirely. The
      // immutability trigger would refuse it, but the route must not try.
      const id = await grant(2);
      const before = await asAppSuperuser(db, (tx) =>
        tx.$queryRawUnsafe<{ expiresAt: Date }[]>(
          `SELECT "expiresAt" FROM platform_admin_grant WHERE id=$1`,
          id,
        ),
      );

      await POST(req({ 'x-cron-secret': SECRET }) as never);

      const after = await asAppSuperuser(db, (tx) =>
        tx.$queryRawUnsafe<{ expiresAt: Date }[]>(
          `SELECT "expiresAt" FROM platform_admin_grant WHERE id=$1`,
          id,
        ),
      );
      expect(after[0]!.expiresAt).toEqual(before[0]!.expiresAt);

      // And it writes no platform audit row: a cron job reading expiry dates is
      // machine work with no human actor, so there is no grant to audit against.
      const audit = await asAppSuperuser(db, (tx) =>
        tx.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*) AS n FROM platform_audit_entry`),
      );
      expect(Number(audit[0]!.n)).toBe(0);
    });
  });
});
