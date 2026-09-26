import {
  archiveCourt,
  countUpcomingBookings,
  createCourt,
  CourtNotFoundError,
  updateCourt,
  VenueNotFoundError,
} from '@/app-layer/usecases/courts';
import { listCourts } from '@/app-layer/repositories/court';
import { runInTenantContext } from '@/lib/db/rls-middleware';

import { prismaTestClient, resetDatabase, seedTenant } from '../helpers/db';
import { asAppSuperuser } from '../helpers/rls';

/**
 * COURT MUTATIONS, BOUND THE WAY THE SCREEN BINDS THEM.
 *
 * The interesting cases are not "does create create". They are:
 *
 *   a venueId from another club     nothing in the schema refuses it
 *   archive vs delete               the row must survive its bookings
 *   the audit BEFORE value          the only record of who changed a price
 */

const BASE = {
  name: 'Court 1',
  sport: 'PADEL',
  resourceType: 'COURT',
  surface: 'ARTIFICIAL_GRASS',
  isIndoor: false,
  capacity: 4,
  basePriceCents: 2400,
  minBookingMinutes: 60,
  maxBookingMinutes: 180,
  slotStepMinutes: 30,
} as const;

describe('court mutations', () => {
  const db = prismaTestClient();

  async function venueFor(tenantId: string, tag = 'a') {
    return asAppSuperuser(db, (tx) =>
      tx.venue.create({
        data: {
          tenantId,
          name: `Site ${tag}`,
          slug: `site-${tag}-${tenantId.slice(-8)}`,
          addressLine: 'bul. Vitosha 1',
          city: 'Sofia',
          lat: 42.6977,
          lng: 23.3219,
          email: `site-${tag}-${tenantId.slice(-8)}@test.invalid`,
        },
        select: { id: true },
      }),
    );
  }

  const audits = (tenantId: string) =>
    asAppSuperuser(db, (tx) =>
      tx.auditEntry.findMany({
        where: { tenantId, entity: 'Resource' },
        orderBy: { createdAt: 'asc' },
        select: { action: true, actorUserId: true, entityId: true, detailsJson: true },
      }),
    );

  beforeEach(async () => {
    await resetDatabase(db);
  });

  it('THE POINT: creates a court and records who did it', async () => {
    const t = await seedTenant({}, db);
    const v = await venueFor(t.tenantId);

    const court = await runInTenantContext(t.tenantId, (c) =>
      createCourt(c, t.tenantId, t.userId, { ...BASE, venueId: v.id }),
    );

    expect(court).toMatchObject({ name: 'Court 1', basePriceCents: 2400, status: 'ACTIVE' });

    const rows = await audits(t.tenantId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: 'COURT_CREATED',
      actorUserId: t.userId,
      entityId: court.id,
    });
  });

  it('REFUSES a venueId belonging to another club', async () => {
    // ═══ WHY THIS IS THE SHARPEST TEST HERE ═══
    //
    // `Resource.venueId` has no composite foreign key to (tenantId, venueId),
    // so the database will happily attach a court to another club's site. A
    // crafted form post is all it takes, and the result is a court that shows
    // up in someone else's venue.
    const mine = await seedTenant({}, db);
    const theirs = await seedTenant({}, db);
    const theirVenue = await venueFor(theirs.tenantId, 'theirs');

    await expect(
      runInTenantContext(mine.tenantId, (c) =>
        createCourt(c, mine.tenantId, mine.userId, { ...BASE, venueId: theirVenue.id }),
      ),
    ).rejects.toThrow(VenueNotFoundError);

    // And nothing was written, in either club.
    expect(await audits(mine.tenantId)).toHaveLength(0);
    const theirCourts = await runInTenantContext(theirs.tenantId, (c) =>
      listCourts(c, theirs.tenantId),
    );
    expect(theirCourts).toHaveLength(0);
  });

  it('records the BEFORE value on an update, which is the whole point', async () => {
    // "Who put the price up?" has no answer without it — basePriceCents keeps
    // no history of its own.
    const t = await seedTenant({}, db);
    const v = await venueFor(t.tenantId);
    const court = await runInTenantContext(t.tenantId, (c) =>
      createCourt(c, t.tenantId, t.userId, { ...BASE, venueId: v.id }),
    );

    await runInTenantContext(t.tenantId, (c) =>
      updateCourt(c, t.tenantId, t.userId, court.id, { ...BASE, basePriceCents: 3000 }),
    );

    const rows = await audits(t.tenantId);
    const updated = rows.find((r) => r.action === 'COURT_UPDATED');
    expect(updated).toBeDefined();
    const d = updated!.detailsJson as {
      before?: { basePriceCents?: number };
      after?: { basePriceCents?: number };
    };
    expect(d.before?.basePriceCents).toBe(2400);
    expect(d.after?.basePriceCents).toBe(3000);
  });

  it('cannot update another club’s court', async () => {
    const mine = await seedTenant({}, db);
    const theirs = await seedTenant({}, db);
    const theirVenue = await venueFor(theirs.tenantId, 'x');
    const theirCourt = await runInTenantContext(theirs.tenantId, (c) =>
      createCourt(c, theirs.tenantId, theirs.userId, { ...BASE, venueId: theirVenue.id }),
    );

    await expect(
      runInTenantContext(mine.tenantId, (c) =>
        updateCourt(c, mine.tenantId, mine.userId, theirCourt.id, { ...BASE, name: 'Hijacked' }),
      ),
    ).rejects.toThrow(CourtNotFoundError);

    const still = await runInTenantContext(theirs.tenantId, (c) => listCourts(c, theirs.tenantId));
    expect(still[0]!.name).toBe('Court 1');
  });

  it('archives without deleting, and the row survives its bookings', async () => {
    // ═══ WHY THERE IS NO DELETE ═══
    //
    // A court is referenced by every booking made on it, and through those by
    // payments and the ledger. Deleting either fails on a foreign key or, with
    // a cascade, destroys last season's financial record.
    const t = await seedTenant({}, db);
    const v = await venueFor(t.tenantId);
    const court = await runInTenantContext(t.tenantId, (c) =>
      createCourt(c, t.tenantId, t.userId, { ...BASE, venueId: v.id }),
    );

    const start = new Date(Date.now() + 86_400_000);
    await asAppSuperuser(db, (tx) =>
      tx.booking.create({
        data: {
          tenantId: t.tenantId,
          resourceId: court.id,
          bookedByUserId: t.userId,
          startTs: start,
          endTs: new Date(start.getTime() + 3_600_000),
          status: 'CONFIRMED',
          totalCents: 2400,
          // Unique per tenant; the booking path normally supplies it.
          idempotencyKey: `archive-fixture-${court.id}`,
        },
      }),
    );

    await runInTenantContext(t.tenantId, (c) => archiveCourt(c, t.tenantId, t.userId, court.id));

    // Hidden from the working list…
    const visible = await runInTenantContext(t.tenantId, (c) => listCourts(c, t.tenantId));
    expect(visible).toHaveLength(0);

    // …but the row, and the booking pointing at it, are both still there.
    const archived = await runInTenantContext(t.tenantId, (c) =>
      listCourts(c, t.tenantId, { includeArchived: true }),
    );
    expect(archived).toHaveLength(1);
    expect(archived[0]!.status).toBe('CLOSED');

    const upcoming = await runInTenantContext(t.tenantId, (c) =>
      countUpcomingBookings(c, t.tenantId, court.id, new Date()),
    );
    expect(upcoming).toBe(1);
  });

  it('reopens an archived court', async () => {
    const t = await seedTenant({}, db);
    const v = await venueFor(t.tenantId);
    const court = await runInTenantContext(t.tenantId, (c) =>
      createCourt(c, t.tenantId, t.userId, { ...BASE, venueId: v.id }),
    );

    await runInTenantContext(t.tenantId, (c) => archiveCourt(c, t.tenantId, t.userId, court.id));
    await runInTenantContext(t.tenantId, (c) =>
      archiveCourt(c, t.tenantId, t.userId, court.id, { reopen: true }),
    );

    const visible = await runInTenantContext(t.tenantId, (c) => listCourts(c, t.tenantId));
    expect(visible.map((r) => r.status)).toEqual(['ACTIVE']);

    const actions = (await audits(t.tenantId)).map((r) => r.action);
    expect(actions).toEqual(['COURT_CREATED', 'COURT_ARCHIVED', 'COURT_REOPENED']);
  });

  it('counts only FUTURE, live bookings for the archive warning', async () => {
    // A past booking is not a reason to hesitate, and a cancelled one is not
    // either — warning about them would make the warning noise.
    const t = await seedTenant({}, db);
    const v = await venueFor(t.tenantId);
    const court = await runInTenantContext(t.tenantId, (c) =>
      createCourt(c, t.tenantId, t.userId, { ...BASE, venueId: v.id }),
    );

    const past = new Date(Date.now() - 172_800_000);
    const future = new Date(Date.now() + 172_800_000);
    await asAppSuperuser(db, async (tx) => {
      for (const [startTs, status] of [
        [past, 'COMPLETED'],
        [future, 'CANCELLED'],
        [future, 'CONFIRMED'],
      ] as const) {
        await tx.booking.create({
          data: {
            tenantId: t.tenantId,
            resourceId: court.id,
            bookedByUserId: t.userId,
            startTs,
            endTs: new Date(startTs.getTime() + 3_600_000),
            status,
            totalCents: 2400,
            idempotencyKey: `count-fixture-${status}-${startTs.getTime()}`,
          },
        });
      }
    });

    const n = await runInTenantContext(t.tenantId, (c) =>
      countUpcomingBookings(c, t.tenantId, court.id, new Date()),
    );
    expect(n).toBe(1);
  });
});
