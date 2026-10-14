import type { PrismaClient } from '@prisma/client';

import { pgErrorCode } from '@/lib/db/pg-errors';

import { prismaTestClient, seedTenant, seedVenue } from '../helpers/db';
import { asAppSuperuser, asAppUser } from '../helpers/rls';

/**
 * THE RESULT OF A BOOKING (#574, P78): one per booking, a club's row.
 *
 * The workflow (reporting, confirming, the club deciding) is #575; what this
 * holds is the table's own promises, which no use case can undo: one result
 * a booking, a race with no score, and a club that sees only its own.
 */
const HOUR = 3_600_000;

describe('match_report', () => {
  const db: PrismaClient = prismaTestClient();

  async function bookingAt(): Promise<{ tenantId: string; bookingId: string; userId: string }> {
    const club = await seedTenant({}, db);
    const { resourceId } = await seedVenue(club.tenantId, {}, db);
    const bookingId = await asAppSuperuser(db, async (tx) => {
      const b = await tx.booking.create({
        data: {
          tenantId: club.tenantId,
          resourceId,
          startTs: new Date(Date.now() - 3 * HOUR),
          endTs: new Date(Date.now() - 2 * HOUR),
          status: 'COMPLETED',
          totalCents: 2400,
          bookedByUserId: club.userId,
          idempotencyKey: `report-${Math.random()}`,
        },
        select: { id: true },
      });
      return b.id;
    });
    return { tenantId: club.tenantId, bookingId, userId: club.userId };
  }

  const report = (b: { tenantId: string; bookingId: string; userId: string }, over = {}) => ({
    tenantId: b.tenantId,
    bookingId: b.bookingId,
    sport: 'TENNIS' as const,
    kind: 'SCORE' as const,
    sidesJson: [[b.userId], ['someone-else']],
    scoreJson: [
      [6, 4],
      [6, 3],
    ],
    winnerSide: 0,
    reportedByUserId: b.userId,
    autoConfirmAt: new Date(Date.now() + 48 * HOUR),
    ...over,
  });

  const codeOf = async (p: Promise<unknown>) => {
    try {
      await p;
      return null;
    } catch (error) {
      return pgErrorCode(error);
    }
  };

  it('a club writes the result of its own booking, once', async () => {
    const b = await bookingAt();
    const row = await asAppUser(db, b.tenantId, (tx) =>
      tx.matchReport.create({ data: report(b), select: { status: true } }),
    );
    expect(row.status).toBe('REPORTED');

    // One result a booking: a second report is a unique violation.
    expect(
      await codeOf(asAppUser(db, b.tenantId, (tx) => tx.matchReport.create({ data: report(b) }))),
    ).toBe('23505');
  });

  it('another club neither sees it nor writes one for it', async () => {
    const b = await bookingAt();
    await asAppUser(db, b.tenantId, (tx) => tx.matchReport.create({ data: report(b) }));
    const other = await seedTenant({}, db);

    const seen = await asAppUser(db, other.tenantId, (tx) =>
      tx.matchReport.findMany({ where: { bookingId: b.bookingId } }),
    );
    expect(seen).toEqual([]);

    // Writing a row that names the first club, from the second club's binding.
    const b2 = await bookingAt();
    expect(
      await codeOf(
        asAppUser(db, other.tenantId, (tx) => tx.matchReport.create({ data: report(b2) })),
      ),
    ).toBe('42501');
  });

  it('a race has no score and no winning side', async () => {
    const b = await bookingAt();
    expect(
      await codeOf(
        asAppUser(db, b.tenantId, (tx) =>
          tx.matchReport.create({
            data: report(b, { kind: 'ORDER', sport: 'KARTING' }),
          }),
        ),
      ),
    ).toBe('23514');

    const ok = await asAppUser(db, b.tenantId, (tx) =>
      tx.matchReport.create({
        data: report(b, {
          kind: 'ORDER',
          sport: 'KARTING',
          sidesJson: [['d1'], ['d2'], ['d3']],
          scoreJson: undefined,
          winnerSide: null,
        }),
        select: { kind: true },
      }),
    );
    expect(ok.kind).toBe('ORDER');
  });

  it('goes with its booking', async () => {
    const b = await bookingAt();
    await asAppUser(db, b.tenantId, (tx) => tx.matchReport.create({ data: report(b) }));
    await asAppSuperuser(db, (tx) => tx.booking.delete({ where: { id: b.bookingId } }));
    const left = await asAppSuperuser(db, (tx) =>
      tx.matchReport.count({ where: { bookingId: b.bookingId } }),
    );
    expect(left).toBe(0);
  });

  it('every account’s rating is public until the person says otherwise (decision 36)', async () => {
    const b = await bookingAt();
    const user = await asAppSuperuser(db, (tx) =>
      tx.user.findUniqueOrThrow({ where: { id: b.userId }, select: { ratingPublic: true } }),
    );
    expect(user.ratingPublic).toBe(true);
  });
});
