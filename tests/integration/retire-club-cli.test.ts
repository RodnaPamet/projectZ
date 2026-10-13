import { execFileSync } from 'node:child_process';

import { prismaTestClient, seedTenant, seedVenue } from '../helpers/db';
import { asAppSuperuser } from '../helpers/rls';

/**
 * `scripts/retire-club.ts` (#459), run as a CLI: a club account deleted on
 * request. A dry run unless `--confirm` names the club the address leads to;
 * confirmed, it closes the club, cancels its upcoming bookings and deletes the
 * holder's account, keeping the club's records.
 */
const SCRIPT = 'scripts/retire-club.ts';
const db = prismaTestClient();
const REASON = 'the club asked by email to leave';

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

async function clubWithBooking() {
  const club = await seedTenant({});
  const court = await seedVenue(club.tenantId, { name: 'Бета Кортове' });
  const start = new Date(Date.now() + 2 * 24 * 3_600_000);
  const booking = await asAppSuperuser(db, (tx) =>
    tx.booking.create({
      data: {
        tenantId: club.tenantId,
        resourceId: court.resourceId,
        startTs: start,
        endTs: new Date(start.getTime() + 3_600_000),
        totalCents: 2400,
        status: 'CONFIRMED',
        channel: 'ONLINE',
        idempotencyKey: `retire-${club.tenantId}`,
      },
    }),
  );
  return { club, booking };
}

const state = (tenantId: string, bookingId: string, userId: string) =>
  asAppSuperuser(db, async (tx) => ({
    club: (await tx.venueOrg.findUniqueOrThrow({ where: { id: tenantId } })).status,
    booking: (await tx.booking.findUniqueOrThrow({ where: { id: bookingId } })).status,
    deleted: (await tx.user.findUniqueOrThrow({ where: { id: userId } })).deletedAt !== null,
  }));

describe('npm run retire:club (#459)', () => {
  it('a dry run shows the club and what would change, and writes nothing', async () => {
    const { club, booking } = await clubWithBooking();
    const run = cli(['--email', club.ownerEmail]);

    expect(run.code).toBe(0);
    expect(run.out).toContain(club.tenantId);
    expect(run.out).toContain('upcoming bookings to cancel, each player told: 1');
    expect(run.out).toContain('DRY RUN');
    expect(await state(club.tenantId, booking.id, club.userId)).toEqual({
      club: 'ACTIVE',
      booking: 'CONFIRMED',
      deleted: false,
    });
  });

  it('refuses a --confirm that names another club', async () => {
    const { club, booking } = await clubWithBooking();
    const run = cli([
      '--email',
      club.ownerEmail,
      '--confirm',
      'cnotthisclub0000000000000',
      '--reason',
      REASON,
    ]);

    expect(run.code).toBe(1);
    expect(run.out).toContain('Nothing was written');
    expect((await state(club.tenantId, booking.id, club.userId)).club).toBe('ACTIVE');
  });

  it('confirmed: closes the club, cancels its booking and deletes the account', async () => {
    const { club, booking } = await clubWithBooking();
    const run = cli(['--email', club.ownerEmail, '--confirm', club.tenantId, '--reason', REASON]);

    expect(run.code).toBe(0);
    expect(run.out).toContain('is closed');
    expect(run.out).toContain('Bookings cancelled: 1');
    expect(await state(club.tenantId, booking.id, club.userId)).toEqual({
      club: 'CLOSED',
      booking: 'CANCELLED',
      deleted: true,
    });
    const audit = await asAppSuperuser(db, (tx) =>
      tx.auditEntry.findFirst({
        where: { tenantId: club.tenantId, action: 'CLUB_STATUS_CHANGED' },
        select: { actorType: true, actorUserId: true },
      }),
    );
    expect(audit).toEqual({ actorType: 'SYSTEM', actorUserId: null });
  });
});
