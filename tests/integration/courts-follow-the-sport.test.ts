import { courtCreateSchema } from '@/app-layer/schemas/court';
import { clubResourceNouns } from '@/app-layer/usecases/club-nouns';
import { createCourt } from '@/app-layer/usecases/courts';
import { clubAdminNav } from '@/components/layout/nav-items';
import { runInTenantContext } from '@/lib/db/rls-middleware';
import type { SportType } from '@prisma/client';

import bg from '../../messages/bg.json';
import { prismaTestClient, resetDatabase, seedTenant } from '../helpers/db';
import { asAppSuperuser } from '../helpers/rls';

/**
 * A RESOURCE ADDED ON THE COURTS SCREEN FOLLOWS ITS SPORT (#472).
 *
 * The form asks for no type, and the server used to store every sport but
 * karting as a COURT. Since a FIELD reads "игрище" (#454), a pitches-only club
 * that added a fifth pitch would have read "Кортове и игрища", and the new
 * pitch "корт". Owner decision (2026-10-09): follow the sport. Football,
 * 5-a-side and handball are FIELDs, tennis, padel and squash COURTs, karting
 * a TRACK. Rows already stored are not changed.
 *
 * The screen's own path: the form's fields, parsed by `courtCreateSchema` with
 * no type (as `createCourtAction` does), then `createCourt` in the club's
 * context.
 */

const FORM = {
  surface: 'ARTIFICIAL_GRASS',
  isIndoor: false,
  capacity: 10,
  basePriceCents: 8000,
  minBookingMinutes: 60,
  maxBookingMinutes: 120,
  slotStepMinutes: 60,
} as const;

describe('a resource added on the courts screen follows its sport (#472)', () => {
  const db = prismaTestClient();

  async function club() {
    const t = await seedTenant({}, db);
    const venue = await asAppSuperuser(db, (tx) =>
      tx.venue.create({
        data: {
          tenantId: t.tenantId,
          name: 'Спортна София',
          slug: `sport-${t.tenantId.slice(-8)}`,
          addressLine: 'ж.к. Младост 1',
          city: 'Sofia',
          lat: 42.65,
          lng: 23.37,
          email: `sport-${t.tenantId.slice(-8)}@test.invalid`,
        },
        select: { id: true },
      }),
    );
    return { ...t, venueId: venue.id };
  }

  /** Add a resource as the courts screen does: no type in the form. */
  async function add(c: { tenantId: string; userId: string; venueId: string }, sport: SportType) {
    const input = courtCreateSchema.parse({
      ...FORM,
      venueId: c.venueId,
      name: `${sport} 1`,
      sport,
    });
    return runInTenantContext(c.tenantId, (tx) => createCourt(tx, c.tenantId, c.userId, input));
  }

  beforeEach(async () => {
    await resetDatabase(db);
  });

  it.each([
    ['FOOTBALL', 'FIELD'],
    ['FOOTBALL5', 'FIELD'],
    ['HANDBALL', 'FIELD'],
    ['TENNIS', 'COURT'],
    ['PADEL', 'COURT'],
    ['SQUASH', 'COURT'],
    ['KARTING', 'TRACK'],
  ] as const)('%s is stored as a %s', async (sport, type) => {
    const c = await club();
    const court = await add(c, sport);
    const row = await asAppSuperuser(db, (tx) =>
      tx.resource.findUniqueOrThrow({ where: { id: court.id }, select: { resourceType: true } }),
    );
    expect(row.resourceType).toBe(type);
  });

  it('a pitches-only club still reads "Игрища" after adding a pitch', async () => {
    const c = await club();
    // Four pitches, as the pilot club has, and a fifth added on the screen.
    await asAppSuperuser(db, (tx) =>
      tx.resource.createMany({
        data: [1, 2, 3, 4].map((n) => ({
          ...FORM,
          tenantId: c.tenantId,
          venueId: c.venueId,
          name: `Игрище ${n}`,
          sport: 'FOOTBALL5' as const,
          resourceType: 'FIELD' as const,
        })),
      }),
    );
    expect(await clubResourceNouns(c.tenantId)).toBe('pitch');

    await add(c, 'FOOTBALL5');

    const nouns = await clubResourceNouns(c.tenantId);
    expect(nouns).toBe('pitch');
    const courts = clubAdminNav('sport', nouns)
      .flatMap((s) => s.items)
      .find((i) => i.href.endsWith('/courts'))!;
    expect(courts.labelKey).toBe('pitch.courts');
    expect(bg.common.nav.pitch.courts).toBe('Игрища');
  });
});
