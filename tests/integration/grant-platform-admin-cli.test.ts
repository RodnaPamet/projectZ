import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

import { prismaTestClient, resetDatabase } from '../helpers/db';
import { asAppSuperuser } from '../helpers/rls';

/**
 * THE CLI, RUN AS A CLI.
 *
 * ═══ WHY THIS EXISTS ═══
 *
 * `scripts/grant-platform-admin.ts` is the ONLY writer of platform authority —
 * there is no API route, deliberately, so that a stolen admin session cannot
 * mint a peer. It shipped verified by hand: I ran every path against a scratch
 * database and read the output. Nothing automated checked any of it, so the next
 * edit to argument parsing or the refusal messages would break it silently.
 *
 * ═══ WHY IT SPAWNS THE SCRIPT INSTEAD OF IMPORTING IT ═══
 *
 * The script's contract IS its command line: flags, exit codes, and the message
 * a human reads at 03:00. Importing a refactored-out function would test the
 * part that was never in doubt and skip `parseArgs`, the `fail()` exit path, and
 * the constraint-name translation — which is where the behaviour somebody
 * depends on actually lives.
 *
 * It also means the database constraints do the refusing, exactly as in
 * production. Every "refused" case below is Postgres saying no, not a mock.
 */

const SCRIPT = 'scripts/grant-platform-admin.ts';

interface Run {
  code: number;
  out: string;
}

/** Run the CLI against the test database. Never throws; returns the exit code. */
function cli(args: string[]): Run {
  try {
    const out = execFileSync('npx', ['tsx', SCRIPT, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        // The CLI prefers DIRECT_DATABASE_URL — it needs the owner connection,
        // because the grant table denies app_user and after P24 the runtime role
        // cannot write tables at all.
        DIRECT_DATABASE_URL: process.env.DIRECT_DATABASE_URL ?? process.env.DATABASE_URL ?? '',
      },
    });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? 1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

describe('grant-platform-admin CLI', () => {
  const db = prismaTestClient();
  let alice: string;
  let bob: string;

  beforeEach(async () => {
    await resetDatabase(db);
    alice = `alice-${randomUUID().slice(0, 8)}@test.invalid`;
    bob = `bob-${randomUUID().slice(0, 8)}@test.invalid`;
    await asAppSuperuser(db, (tx) =>
      tx.$executeRawUnsafe(
        `INSERT INTO app_user (id,email,"createdAt","updatedAt")
         VALUES ($1,$2,now(),now()), ($3,$4,now(),now())`,
        `c${randomUUID().replace(/-/g, '').slice(0, 23)}`,
        alice,
        `c${randomUUID().replace(/-/g, '').slice(0, 23)}`,
        bob,
      ),
    );
  });

  /** 30 days out — inside the 90-day cap. */
  const soon = () => new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10);

  /**
   * The TYPED client, not $queryRawUnsafe.
   *
   * My first draft of this helper used a raw query and then asserted
   * `Array.isArray(capabilities)` — which failed, because a raw query returns a
   * Postgres enum array as the string "{TENANT_READ,AUDIT_READ}". The production
   * bug that assertion is guarding was in application code; I reproduced it in
   * the test that was supposed to catch it, which is a neat demonstration of why
   * the rule is "use the typed client", not "remember the quirk".
   */
  const grants = () =>
    asAppSuperuser(db, (tx) =>
      tx.platformAdminGrant.findMany({
        select: { id: true, capabilities: true, revokedAt: true },
      }),
    );

  const audit = () =>
    asAppSuperuser(db, (tx) =>
      tx.$queryRawUnsafe<{ action: string }[]>(
        `SELECT action FROM platform_audit_entry ORDER BY "createdAt"`,
      ),
    );

  describe('issuing', () => {
    it('grants, and writes the audit row in the same breath', async () => {
      const r = cli([
        '--user',
        alice,
        '--granted-by',
        bob,
        '--capabilities',
        'TENANT_READ,AUDIT_READ',
        '--expires',
        soon(),
        '--reason',
        'incident response rota Q4',
      ]);

      expect(r.code).toBe(0);
      expect(r.out).toContain('Granted platform authority');

      const rows = await grants();
      expect(rows).toHaveLength(1);
      // The typed-client fix, asserted through the CLI: a raw query returns this
      // as the string "{TENANT_READ,AUDIT_READ}", and the audit insert then fails
      // on `capabilities[0]` being "{".
      expect(Array.isArray(rows[0]!.capabilities)).toBe(true);
      expect(rows[0]!.capabilities).toEqual(['TENANT_READ', 'AUDIT_READ']);

      expect(await audit()).toEqual([{ action: 'PLATFORM_GRANT_ISSUED' }]);
    });

    it('refuses a self-grant, and says why in words', async () => {
      // The database enforces it; what this checks is that the operator is told
      // something they can act on rather than a constraint name.
      const r = cli([
        '--user',
        alice,
        '--granted-by',
        alice,
        '--capabilities',
        'TENANT_READ',
        '--expires',
        soon(),
        '--reason',
        'bootstrapping myself here',
      ]);

      expect(r.code).toBe(1);
      expect(r.out).toMatch(/Nobody can grant platform authority to themselves/i);
      expect(r.out).toMatch(/two-party/i);
      // And the raw error is still shown, because it is the one that stays true
      // after somebody edits the translation table.
      expect(r.out).toContain('platform_admin_grant_no_self_grant');
      expect(await grants()).toHaveLength(0);
    });

    it('refuses an expiry beyond the 90-day cap', async () => {
      const far = new Date(Date.now() + 365 * 864e5).toISOString().slice(0, 10);
      const r = cli([
        '--user',
        alice,
        '--granted-by',
        bob,
        '--capabilities',
        'TENANT_READ',
        '--expires',
        far,
        '--reason',
        'permanent access please',
      ]);

      expect(r.code).toBe(1);
      expect(r.out).toMatch(/at most 90 days/i);
      expect(await grants()).toHaveLength(0);
    });

    it('refuses a second live grant, and names the fix', async () => {
      const ok = [
        '--user',
        alice,
        '--granted-by',
        bob,
        '--capabilities',
        'TENANT_READ',
        '--expires',
        soon(),
        '--reason',
        'incident response rota',
      ];
      expect(cli(ok).code).toBe(0);

      const r = cli(ok);
      expect(r.code).toBe(1);
      // Naming --revoke matters: this is the message somebody hits mid-incident,
      // and "duplicate key value violates unique constraint" is not a next step.
      expect(r.out).toMatch(/--revoke/);
      expect(await grants()).toHaveLength(1);
    });

    it('refuses an unknown capability WITHOUT touching the database', async () => {
      const r = cli([
        '--user',
        alice,
        '--granted-by',
        bob,
        '--capabilities',
        'SUPER_ADMIN',
        '--expires',
        soon(),
        '--reason',
        'a capability that does not exist',
      ]);

      expect(r.code).toBe(1);
      expect(r.out).toMatch(/Unknown capabilit/i);
      // It lists the real ones, so the operator does not have to go reading code.
      expect(r.out).toContain('TENANT_READ');
      expect(await grants()).toHaveLength(0);
    });

    it('tolerates a trailing comma in --capabilities', async () => {
      // A trailing comma is the easiest possible typo when copying a line out of
      // the runbook, and it used to fail with `Unknown capability: ` followed by
      // nothing — which tells the operator nothing about what to change.
      //
      // Forgiving about punctuation, strict about names: see the next test.
      const r = cli([
        '--user',
        alice,
        '--granted-by',
        bob,
        '--capabilities',
        'TENANT_READ,',
        '--expires',
        soon(),
        '--reason',
        'a trailing comma should be fine',
      ]);

      expect(r.code).toBe(0);
      const rows = await grants();
      expect(rows[0]!.capabilities).toEqual(['TENANT_READ']);
    });

    it('still refuses a genuine misspelling', async () => {
      // The reason the tolerance above is safe. `AUDIT_RAED` is not punctuation.
      const r = cli([
        '--user',
        alice,
        '--granted-by',
        bob,
        '--capabilities',
        'AUDIT_RAED',
        '--expires',
        soon(),
        '--reason',
        'a genuine misspelling here',
      ]);

      expect(r.code).toBe(1);
      expect(r.out).toContain('AUDIT_RAED');
      expect(await grants()).toHaveLength(0);
    });

    it('refuses --capabilities that is only punctuation, and says what is valid', async () => {
      const r = cli([
        '--user',
        alice,
        '--granted-by',
        bob,
        '--capabilities',
        ',,',
        '--expires',
        soon(),
        '--reason',
        'only commas were supplied',
      ]);

      expect(r.code).toBe(1);
      expect(r.out).toMatch(/no capability names/i);
      // Listing them, so the operator does not go reading source at 03:00.
      expect(r.out).toContain('TENANT_READ');
      expect(await grants()).toHaveLength(0);
    });

    it('refuses an email that is not a real account', async () => {
      const r = cli([
        '--user',
        'ghost@nowhere.invalid',
        '--granted-by',
        bob,
        '--capabilities',
        'TENANT_READ',
        '--expires',
        soon(),
        '--reason',
        'a user who does not exist',
      ]);

      expect(r.code).toBe(1);
      expect(r.out).toMatch(/No user with email/);
      // Naming WHICH flag was wrong, because with two email flags "no such user"
      // alone sends you checking the wrong one.
      expect(r.out).toContain('--user');
    });

    it('requires every flag, with no defaults', async () => {
      // A default expiry becomes the expiry everybody uses; a default reason is
      // no reason at all.
      for (const missing of ['--expires', '--capabilities', '--reason', '--granted-by']) {
        const args = [
          '--user',
          alice,
          '--granted-by',
          bob,
          '--capabilities',
          'TENANT_READ',
          '--expires',
          soon(),
          '--reason',
          'incident response rota',
        ];
        const i = args.indexOf(missing);
        args.splice(i, 2);

        const r = cli(args);
        expect(r.code).toBe(1);
        expect(r.out).toContain(missing);
      }
    });
  });

  describe('expiry semantics', () => {
    it('treats a bare date as the END of that day, not the start', async () => {
      // `new Date('2026-09-26')` is midnight UTC. So the runbook's own incident
      // recipe — `--expires <tomorrow>` — produced a grant that died at midnight:
      // issued at 19:37 it lasted 4h22m, at 23:30 it lasted thirty minutes. Both
      // measured. From a positive offset it was worse: `--expires 2026-11-01`
      // from Sofia expired at 02:00 local, dead for the working day it covered.
      const tomorrow = new Date(Date.now() + 864e5).toISOString().slice(0, 10);

      const r = cli([
        '--user',
        alice,
        '--granted-by',
        bob,
        '--capabilities',
        'TENANT_READ',
        '--expires',
        tomorrow,
        '--reason',
        'an incident grant for tomorrow',
      ]);

      expect(r.code).toBe(0);
      expect(r.out).toContain('23:59:59.999Z');
      // And it says so, because the ISO string alone is easy to skim past at 03:00.
      expect(r.out).toMatch(/end of the day you named/);

      const rows = await asAppSuperuser(db, (tx) =>
        tx.$queryRawUnsafe<{ hours: number }[]>(
          `SELECT EXTRACT(EPOCH FROM ("expiresAt" - now()))/3600 AS hours
             FROM platform_admin_grant`,
        ),
      );
      // Comfortably more than a day away, whatever hour this test runs at. The
      // old behaviour could leave under an hour.
      expect(Number(rows[0]!.hours)).toBeGreaterThan(24);
    });

    it('honours a full ISO timestamp verbatim', async () => {
      // Anyone who wants a precise instant must still be able to say so.
      const precise = new Date(Date.now() + 5 * 864e5).toISOString();

      const r = cli([
        '--user',
        alice,
        '--granted-by',
        bob,
        '--capabilities',
        'TENANT_READ',
        '--expires',
        precise,
        '--reason',
        'a precise expiry instant',
      ]);

      expect(r.code).toBe(0);
      expect(r.out).toContain(precise);
      expect(r.out).not.toMatch(/end of the day you named/);
    });
  });

  describe('revoking', () => {
    const issue = () =>
      cli([
        '--user',
        alice,
        '--granted-by',
        bob,
        '--capabilities',
        'TENANT_READ',
        '--expires',
        soon(),
        '--reason',
        'incident response rota',
      ]);

    it('revokes, and audits the revocation', async () => {
      expect(issue().code).toBe(0);

      const r = cli([
        '--revoke',
        alice,
        '--granted-by',
        bob,
        '--reason',
        'rota ended this quarter',
      ]);
      expect(r.code).toBe(0);
      expect(r.out).toContain('Revoked platform authority');
      // The runbook promises this sentence. If the wording drifts, the runbook is
      // wrong rather than merely stale.
      expect(r.out).toMatch(/next request/i);

      const rows = await grants();
      expect(rows[0]!.revokedAt).not.toBeNull();
      // A log showing every grant and no revocation tells the wrong story: that
      // authority only ever accumulates.
      expect(await audit()).toEqual([
        { action: 'PLATFORM_GRANT_ISSUED' },
        { action: 'PLATFORM_GRANT_REVOKED' },
      ]);
    });

    it('frees the slot, so the runbook’s revoke-then-reissue actually works', async () => {
      // This exact two-step is what docs/platform-admin-runbook.md tells somebody
      // to do at 03:00 when a grant has lapsed. If it did not work, the runbook
      // would be sending them into a wall.
      expect(issue().code).toBe(0);
      expect(
        cli(['--revoke', alice, '--granted-by', bob, '--reason', 'lapsed during incident']).code,
      ).toBe(0);
      expect(issue().code).toBe(0);

      const rows = await grants();
      expect(rows).toHaveLength(2);
      expect(rows.filter((g) => g.revokedAt === null)).toHaveLength(1);
    });

    it('lets ONE person revoke, including their own grant', async () => {
      // The fast path during a suspected compromise, and nothing about it should
      // wait for a second person. The no-self-grant CHECK applies to ISSUING
      // authority, not to ending it.
      //
      // The runbook said both commands needed two people, which would have told a
      // lone on-call they were blocked from revocation. Verified by doing it.
      expect(issue().code).toBe(0);

      const r = cli([
        '--revoke',
        alice,
        '--granted-by',
        alice,
        '--reason',
        'revoking my own grant',
      ]);

      expect(r.code).toBe(0);
      const rows = await grants();
      expect(rows[0]!.revokedAt).not.toBeNull();
    });

    it('refuses a revoke reason under 12 characters, which the database does not check', async () => {
      // `platform_admin_grant_reason_stated` covers the GRANT's reason only;
      // `revokeReason` has no CHECK. So "rota ended" — the runbook's own example,
      // ten characters — was accepted while the CLI claimed twelve were enforced.
      expect(issue().code).toBe(0);

      const r = cli(['--revoke', alice, '--granted-by', bob, '--reason', 'rota ended']);

      expect(r.code).toBe(1);
      expect(r.out).toMatch(/at least 12 characters/);
      const rows = await grants();
      expect(rows[0]!.revokedAt).toBeNull();
    });

    it('says so plainly when there is nothing to revoke', async () => {
      const r = cli(['--revoke', alice, '--granted-by', bob, '--reason', 'nothing live to revoke']);

      expect(r.code).toBe(1);
      expect(r.out).toMatch(/no live grant/i);
    });
  });
});
