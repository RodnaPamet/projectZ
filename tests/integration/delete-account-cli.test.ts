import { execFileSync } from 'node:child_process';

import { tombstoneEmail } from '@/lib/account/deleted-user';

import { seedPlayer } from '../helpers/auth';
import { prismaTestClient, seedTenant, seedVenue } from '../helpers/db';
import { asAppSuperuser } from '../helpers/rls';

/**
 * `scripts/delete-account.ts` (#370), run as a CLI: the operator's path for a
 * deletion asked for by email. It is `deleteAccount`, the use case behind
 * `DELETE /api/v1/me`, so the rules are the same ones; what is tested here is
 * the command line around them: the flags, the dry run that writes nothing,
 * the refusals an operator reads, and the exit codes.
 */
const SCRIPT = 'scripts/delete-account.ts';
const db = prismaTestClient();

function cli(args: string[]): { code: number; out: string } {
  try {
    const out = execFileSync('npx', ['tsx', SCRIPT, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        DIRECT_DATABASE_URL: process.env.DIRECT_DATABASE_URL ?? process.env.DATABASE_URL ?? '',
      },
    });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? 1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

const emailOf = (userId: string) =>
  asAppSuperuser(db, (tx) =>
    tx.user.findUniqueOrThrow({ where: { id: userId }, select: { email: true, deletedAt: true } }),
  );

describe('npm run delete:account (#370)', () => {
  it('a dry run writes nothing; the real run deletes, and a second finds no account', async () => {
    const club = await seedTenant({});
    const userId = await seedPlayer(db, club.tenantId, 'byemail');
    const { email } = await emailOf(userId);

    const dry = cli(['--email', email.toUpperCase(), '--dry-run']);
    expect(dry).toMatchObject({ code: 0 });
    expect(dry.out).toContain('DRY RUN');
    expect(dry.out).toMatch(/TenantMembership\s+1/);
    expect(await emailOf(userId)).toEqual({ email, deletedAt: null });

    const real = cli(['--email', email]);
    expect(real.code).toBe(0);
    expect(real.out).toContain('Deleted');
    const after = await emailOf(userId);
    expect(after.email).toBe(tombstoneEmail(userId));
    expect(after.deletedAt).toBeInstanceOf(Date);

    const again = cli(['--email', email]);
    expect(again.code).toBe(1);
    expect(again.out).toContain('No account has the address');
  });

  it('refuses a club account and names the follow-up', async () => {
    const club = await seedTenant({});
    const run = cli(['--email', club.ownerEmail]);
    expect(run.code).toBe(1);
    expect(run.out).toContain('CLUB account');
    expect(run.out).toContain('#459');
    expect((await emailOf(club.userId)).deletedAt).toBeNull();
  });

  it('refuses while the person has an upcoming booking, and lists it', async () => {
    const club = await seedTenant({});
    const court = await seedVenue(club.tenantId, { name: 'Алфа Кортове' });
    const userId = await seedPlayer(db, club.tenantId, 'stillplaying');
    const start = new Date(Date.now() + 2 * 24 * 3_600_000);
    await asAppSuperuser(db, (tx) =>
      tx.booking.create({
        data: {
          tenantId: club.tenantId,
          resourceId: court.resourceId,
          startTs: start,
          endTs: new Date(start.getTime() + 3_600_000),
          bookedByUserId: userId,
          totalCents: 2400,
          status: 'CONFIRMED',
          idempotencyKey: `cli-${Math.random()}`,
        },
      }),
    );
    const run = cli(['--email', (await emailOf(userId)).email]);
    expect(run.code).toBe(1);
    expect(run.out).toContain('1 upcoming booking');
    expect(run.out).toContain('Алфа Кортове');
    expect((await emailOf(userId)).deletedAt).toBeNull();
  });

  it('without --email it says how to call it', () => {
    const run = cli([]);
    expect(run.code).toBe(1);
    expect(run.out).toContain('Usage: npm run delete:account -- --email');
  });
});
