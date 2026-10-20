import { CourtNotFoundError, createCourt, VenueNotFoundError } from '@/app-layer/usecases/courts';
import {
  InvalidOutlineError,
  loadVenuePlanEditor,
  saveVenuePlan,
} from '@/app-layer/usecases/venue-plan-editor';
import { AUDIT_ACTIONS } from '@/lib/audit';
import { runInTenantContext } from '@/lib/db/rls-middleware';
import type { PlanPoint } from '@/lib/venues/plan';

import { prismaTestClient, resetDatabase, seedTenant } from '../helpers/db';
import { asAppSuperuser } from '../helpers/rls';

/**
 * THE CLUB'S PLAN (#626), BOUND AS THE EDITOR BINDS IT.
 *
 *   an outline the club saves        is the club's, and the importer's way id goes
 *   a court taken off the plan       has no outline and no source (court_plan_whole)
 *   another club's venue or court    refuses the whole save, writing nothing
 *   a shape that is not a polygon    refuses the whole save, writing nothing
 *   every court changed              is an audit row, before and after
 */

const BASE = {
  sport: 'PADEL',
  resourceType: 'COURT',
  surface: 'ARTIFICIAL_GRASS',
  isIndoor: false,
  capacity: 4,
  basePriceCents: 2400,
  minBookingMinutes: 60,
  maxBookingMinutes: 120,
  slotStepMinutes: 60,
} as const;

const RECT = (x: number): PlanPoint[] => [
  [x, 0],
  [x + 20, 0],
  [x + 20, 10],
  [x, 10],
];

describe('the venue plan editor', () => {
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

  async function club(tag = 'a') {
    const t = await seedTenant({}, db);
    const v = await venueFor(t.tenantId, tag);
    const [one, two] = await runInTenantContext(t.tenantId, async (c) => [
      await createCourt(c, t.tenantId, t.userId, { ...BASE, name: 'Court 1', venueId: v.id }),
      await createCourt(c, t.tenantId, t.userId, { ...BASE, name: 'Court 2', venueId: v.id }),
    ]);
    return { ...t, venueId: v.id, one: one!.id, two: two!.id };
  }

  const stored = (id: string) =>
    asAppSuperuser(db, (tx) =>
      tx.resource.findUniqueOrThrow({
        where: { id },
        select: { planOutline: true, planSource: true, planOsmWayId: true },
      }),
    );

  beforeEach(async () => {
    await resetDatabase(db);
  });

  it('THE POINT: saves the club’s outlines as the club’s, and the editor reads them back', async () => {
    const c = await club();
    // Court 1 came from OpenStreetMap; the club moves it.
    await asAppSuperuser(db, (tx) =>
      tx.resource.update({
        where: { id: c.one },
        data: { planOutline: RECT(0), planSource: 'OSM', planOsmWayId: BigInt(42) },
      }),
    );

    await runInTenantContext(c.tenantId, (tx) =>
      saveVenuePlan(tx, c.tenantId, c.userId, c.venueId, [
        { resourceId: c.one, outline: RECT(1) },
        { resourceId: c.two, outline: RECT(23) },
      ]),
    );

    expect(await stored(c.one)).toEqual({
      planOutline: RECT(1),
      planSource: 'CLUB',
      planOsmWayId: null,
    });
    expect(await stored(c.two)).toMatchObject({ planOutline: RECT(23), planSource: 'CLUB' });

    const editor = await runInTenantContext(c.tenantId, (tx) =>
      loadVenuePlanEditor(tx, c.tenantId, c.venueId),
    );
    expect(editor?.courts).toEqual([
      { resourceId: c.one, name: 'Court 1', sport: 'PADEL', outline: RECT(1), source: 'CLUB' },
      { resourceId: c.two, name: 'Court 2', sport: 'PADEL', outline: RECT(23), source: 'CLUB' },
    ]);
  });

  it('takes a court off the plan: no outline, no source, no way id', async () => {
    const c = await club();
    await runInTenantContext(c.tenantId, (tx) =>
      saveVenuePlan(tx, c.tenantId, c.userId, c.venueId, [{ resourceId: c.one, outline: RECT(0) }]),
    );
    await runInTenantContext(c.tenantId, (tx) =>
      saveVenuePlan(tx, c.tenantId, c.userId, c.venueId, [{ resourceId: c.one, outline: null }]),
    );
    expect(await stored(c.one)).toEqual({
      planOutline: null,
      planSource: null,
      planOsmWayId: null,
    });
  });

  it('records each court changed, with its outline before and after', async () => {
    const c = await club();
    await runInTenantContext(c.tenantId, (tx) =>
      saveVenuePlan(tx, c.tenantId, c.userId, c.venueId, [{ resourceId: c.two, outline: RECT(5) }]),
    );
    const rows = await asAppSuperuser(db, (tx) =>
      tx.auditEntry.findMany({
        where: { tenantId: c.tenantId, action: AUDIT_ACTIONS.COURT_PLAN_CHANGED },
        select: { actorUserId: true, entityId: true, detailsJson: true },
      }),
    );
    expect(rows).toEqual([
      {
        actorUserId: c.userId,
        entityId: c.two,
        detailsJson: {
          category: 'config',
          summary: 'Court plan changed',
          before: { outline: null, source: null },
          after: { outline: RECT(5), source: 'CLUB' },
        },
      },
    ]);
  });

  it('refuses the whole save for another club’s court or venue, writing nothing', async () => {
    const mine = await club('a');
    const theirs = await club('b');

    await expect(
      runInTenantContext(mine.tenantId, (tx) =>
        saveVenuePlan(tx, mine.tenantId, mine.userId, mine.venueId, [
          { resourceId: mine.one, outline: RECT(0) },
          { resourceId: theirs.one, outline: RECT(30) },
        ]),
      ),
    ).rejects.toBeInstanceOf(CourtNotFoundError);
    await expect(
      runInTenantContext(mine.tenantId, (tx) =>
        saveVenuePlan(tx, mine.tenantId, mine.userId, theirs.venueId, [
          { resourceId: theirs.one, outline: RECT(0) },
        ]),
      ),
    ).rejects.toBeInstanceOf(VenueNotFoundError);
    expect(
      await runInTenantContext(mine.tenantId, (tx) =>
        loadVenuePlanEditor(tx, mine.tenantId, theirs.venueId),
      ),
    ).toBeNull();

    expect(await stored(mine.one)).toMatchObject({ planOutline: null });
    expect(await stored(theirs.one)).toMatchObject({ planOutline: null });
  });

  it('refuses a shape that is not a polygon, writing nothing', async () => {
    const c = await club();
    await expect(
      runInTenantContext(c.tenantId, (tx) =>
        saveVenuePlan(tx, c.tenantId, c.userId, c.venueId, [
          { resourceId: c.one, outline: RECT(0) },
          {
            resourceId: c.two,
            outline: [
              [0, 0],
              [5, 5],
              [10, 10],
            ],
          },
        ]),
      ),
    ).rejects.toBeInstanceOf(InvalidOutlineError);
    expect(await stored(c.one)).toMatchObject({ planOutline: null });
  });
});
