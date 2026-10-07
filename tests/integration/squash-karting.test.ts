import { randomUUID } from 'node:crypto';

import { NextRequest } from 'next/server';

import { PATCH as patchMe } from '@/app/api/v1/me/route';
import { GET as myBookingsRoute } from '@/app/api/v1/me/bookings/route';
import { POST as deskRoute } from '@/app/api/v1/t/[slug]/admin/desk-bookings/route';
import { POST as bookRoute } from '@/app/api/v1/t/[slug]/bookings/route';
import { GET as availabilityRoute } from '@/app/api/v1/venues/[id]/availability/route';
import { courtCreateSchema } from '@/app-layer/schemas/court';
import { loadClubStatement } from '@/app-layer/usecases/club-fees';
import { createCourt, updateCourt } from '@/app-layer/usecases/courts';
import { loadVenueAvailability } from '@/app-layer/usecases/venue-availability';
import { statementCsv } from '@/lib/billing/statement-csv';
import { runInTenantContext } from '@/lib/db/rls-middleware';
import { bookableSports } from '@/lib/sports/registry';
import { allowedResourceTypes, defaultResourceType } from '@/lib/sports/resources';

import {
  formatItems,
  onboardClub,
  parseClubSpec,
  type ClubSpec,
} from '../../scripts/lib/club-onboarding';
import { signInAs } from '../helpers/auth';
import { prismaTestClient } from '../helpers/db';

/**
 * SQUASH AND KARTING, END TO END (P51).
 *
 * The owner's pilot clubs, as the onboarding spec writes them: Maleeva Club's
 * squash court (sprung hardwood, 2 players, starts every 15 minutes, 45–90
 * minutes) and Sofia Karting Ring's track (coated concrete, up to 10 drivers,
 * every 15 minutes, 15–60 minutes), side by side at one venue here.
 *
 * Judged by the app's own readers, as onboard-club.test.ts is: the slots the
 * venue page renders, the price `POST …/bookings` charges, the desk's write,
 * and the refusal a second group gets for a track that is hired whole.
 */

const db = prismaTestClient();

const SLUG = 'p51-sports-center';
const EVERY_DAY = ['09:00', '12:00'];

/** The spec as JSON, before validation: some cases break it on purpose. */
type Raw = any;

const SQUASH = {
  name: 'Скуош',
  sport: 'SQUASH',
  surface: 'WOOD',
  indoor: true,
  capacity: 2,
  pricePerHourCents: 2400,
  slotStepMinutes: 15,
  minBookingMinutes: 45,
  maxBookingMinutes: 90,
};

const TRACK = {
  name: 'Писта',
  sport: 'KARTING',
  // resourceType left out on purpose: KARTING is a TRACK without being told.
  surface: 'CONCRETE',
  indoor: true,
  capacity: 10,
  pricePerHourCents: 24000,
  slotStepMinutes: 15,
  minBookingMinutes: 15,
  maxBookingMinutes: 60,
};

function rawSpec(courts: Raw[] = [SQUASH, TRACK]): Raw {
  return {
    club: {
      slug: SLUG,
      name: 'P51 Sports Center',
      email: 'hello@p51.test',
      owner: { email: `owner-${randomUUID().slice(0, 8)}@p51.test` },
      cancellationCutoffHours: 24,
      maxUpcomingOnlineBookings: 5,
    },
    venues: [
      {
        slug: 'p51-center',
        name: 'P51 Center',
        address: '1 Test Street',
        city: 'Sofia',
        lat: 42.6977,
        lng: 23.3219,
        hours: Object.fromEntries(
          ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((d) => [d, EVERY_DAY]),
        ),
        courts: structuredClone(courts),
      },
    ],
  };
}

function spec(raw: Raw = rawSpec()): ClubSpec {
  const parsed = parseClubSpec(raw);
  if (!parsed.ok) throw new Error(parsed.errors.join('\n'));
  return parsed.spec;
}

// Monday 17 November 2036; Sofia is UTC+2 in November, so 09:00 is 07:00Z.
const DAY = '2036-11-17';
const WINDOW = { from: new Date('2036-11-16T22:00:00Z'), to: new Date('2036-11-17T22:00:00Z') };
const at = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return new Date(Date.UTC(2036, 10, 17, h! - 2, m!)).toISOString().replace('.000Z', 'Z');
};
const clock = (iso: string | Date) => {
  const d = new Date(iso);
  return `${String(d.getUTCHours() + 2).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
};

async function onboard() {
  const s = spec();
  const result = await onboardClub(db, s);
  expect(result.outcome).toBe('applied');
  const venue = await db.venue.findFirstOrThrow({
    where: { slug: 'p51-center' },
    select: { id: true, name: true, timezone: true, tenantId: true },
  });
  const courts = await db.resource.findMany({
    where: { venueId: venue.id },
    select: { id: true, name: true },
    take: 10,
  });
  const id = (name: string) => courts.find((c) => c.name === name)!.id;
  const owner = await db.user.findUniqueOrThrow({
    where: { email: s.club.owner.email },
    select: { id: true },
  });
  return { venue, squashId: id('Скуош'), trackId: id('Писта'), ownerId: owner.id, result };
}

async function player() {
  const u = await db.user.create({
    data: { email: `player-${randomUUID().slice(0, 8)}@p51.test`, accountKind: 'PLAYER' },
    select: { id: true },
  });
  return signInAs(db, { userId: u.id, memberships: [] });
}

const json = { 'content-type': 'application/json' };

async function book(bearer: string, resourceId: string, from: string, to: string) {
  const res = await bookRoute(
    new NextRequest(`http://t/api/v1/t/${SLUG}/bookings`, {
      method: 'POST',
      headers: { ...json, authorization: `Bearer ${bearer}`, 'idempotency-key': randomUUID() },
      body: JSON.stringify({ resourceId, startTs: at(from), endTs: at(to) }),
    }),
    { params: Promise.resolve({ slug: SLUG }) },
  );
  return { status: res.status, body: (await res.json()) as any };
}

async function slotsOf(venue: { id: string; name: string; timezone: string }, name: string) {
  const all = await loadVenueAvailability(db, { venue, ...WINDOW });
  return all.find((r) => r.resource.name === name)!.slots;
}

// ══ The spec ═════════════════════════════════════════════════════════

describe('the onboarding spec (#365) for squash and karting', () => {
  it('stores the squash court as a COURT and the karting track as a TRACK', async () => {
    const { result } = await onboard();
    const rows = await db.resource.findMany({
      orderBy: { name: 'asc' },
      select: {
        name: true,
        sport: true,
        resourceType: true,
        surface: true,
        isIndoor: true,
        capacity: true,
        basePriceCents: true,
        slotStepMinutes: true,
        minBookingMinutes: true,
        maxBookingMinutes: true,
      },
      take: 10,
    });
    // basePriceCents is ONE minimum-length unit: €24/h for 45 minutes, €240/h for 15.
    expect(rows).toEqual([
      { name: 'Писта', sport: 'KARTING', resourceType: 'TRACK', surface: 'CONCRETE', isIndoor: true, capacity: 10, basePriceCents: 6000, slotStepMinutes: 15, minBookingMinutes: 15, maxBookingMinutes: 60 },
      { name: 'Скуош', sport: 'SQUASH', resourceType: 'COURT', surface: 'WOOD', isIndoor: true, capacity: 2, basePriceCents: 1800, slotStepMinutes: 15, minBookingMinutes: 45, maxBookingMinutes: 90 },
    ]); // prettier-ignore

    // The operator reads the type in the plan.
    expect(result.outcome === 'applied' && formatItems(result.items)).toContain(
      'KARTING TRACK, CONCRETE, indoor, up to 10 players',
    );
  });

  it('refuses a karting court that is not a TRACK, and a TRACK for anything else', () => {
    const notATrack = parseClubSpec(rawSpec([{ ...TRACK, resourceType: 'COURT' }]));
    expect(notATrack.ok).toBe(false);
    expect(!notATrack.ok && notATrack.errors).toEqual([
      'venues[0].courts[0].resourceType: KARTING is booked on a TRACK, and only on one: leave resourceType out, or write "TRACK"',
    ]);

    const tennisTrack = parseClubSpec(
      rawSpec([{ ...SQUASH, sport: 'TENNIS', resourceType: 'TRACK' }]),
    );
    expect(tennisTrack.ok).toBe(false);
    expect(!tennisTrack.ok && tennisTrack.errors.join('\n')).toMatch(
      /resourceType: a TRACK is only for KARTING; a TENNIS court is one of COURT, FIELD/,
    );

    // Explicit and right is as good as left out.
    expect(parseClubSpec(rawSpec([{ ...TRACK, resourceType: 'TRACK' }])).ok).toBe(true);
  });

  it('EVERY bookable sport can be onboarded, on the type the app will call it by', () => {
    // The exhaustiveness check that needs the spec parser: a sport added to
    // the registry is onboardable on day one, or this names it.
    for (const s of bookableSports()) {
      const parsed = parseClubSpec(rawSpec([{ ...SQUASH, name: s.key, sport: s.key }]));
      expect({ sport: s.key, ok: parsed.ok }).toEqual({ sport: s.key, ok: true });
      const court = parsed.ok ? parsed.spec.venues[0]!.courts[0]! : null;
      expect(court?.resourceType).toBe(defaultResourceType(s.key));
      expect(allowedResourceTypes(s.key)).toContain(court?.resourceType);
    }
  });
});

// ══ Availability on the 15-minute grid ═══════════════════════════════

describe('availability', () => {
  it('starts every 15 minutes; squash sells 45 or 90 minutes, the track 15 to 60', async () => {
    const { venue } = await onboard();

    const squash = await slotsOf(venue, 'Скуош');
    expect(squash.map((s) => clock(s.startTs))).toEqual([
      '09:00', '09:15', '09:30', '09:45', '10:00', '10:15', '10:30', '10:45', '11:00', '11:15',
    ]); // prettier-ignore
    expect(squash[0]!.durations?.map((d) => [d.minutes, d.priceCents])).toEqual([
      [45, 1800],
      [90, 3600],
    ]);
    // 10:45 cannot run 90 minutes past closing.
    expect(squash[7]!.durations?.map((d) => d.minutes)).toEqual([45]);

    const track = await slotsOf(venue, 'Писта');
    expect(track.map((s) => clock(s.startTs))).toEqual([
      '09:00', '09:15', '09:30', '09:45', '10:00', '10:15', '10:30', '10:45',
      '11:00', '11:15', '11:30', '11:45',
    ]); // prettier-ignore
    expect(track[0]!.durations?.map((d) => [d.minutes, d.priceCents])).toEqual([
      [15, 6000],
      [30, 12000],
      [45, 18000],
      [60, 24000],
    ]);
  });

  it('the public endpoint names each resource type, for the copy (and the iOS client)', async () => {
    const { venue } = await onboard();
    const res = await availabilityRoute(
      new NextRequest(`http://t/api/v1/venues/${venue.id}/availability?date=${DAY}`),
      { params: Promise.resolve({ id: venue.id }) },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { resources: Array<{ name: string; sport: string; resourceType: string }> };
    };
    expect(body.data.resources.map((r) => [r.name, r.sport, r.resourceType])).toEqual([
      ['Писта', 'KARTING', 'TRACK'],
      ['Скуош', 'SQUASH', 'COURT'],
    ]);
  });
});

// ══ Booking, then the desk ═══════════════════════════════════════════

describe('booking and desk booking treat the track like a court', () => {
  it('a player books squash, the desk books the track, and the track is hired whole', async () => {
    const { venue, squashId, trackId, ownerId } = await onboard();
    const p = await player();

    // ── A player: 45 minutes of squash, 09:15–10:00, charged one unit ──
    const squash = await book(p.bearer, squashId, '09:15', '10:00');
    expect(squash.status).toBe(201);
    expect(squash.body.data).toMatchObject({
      status: 'CONFIRMED',
      totalCents: 1800,
      resource: { id: squashId, sport: 'SQUASH', resourceType: 'COURT' },
    });
    const squashSlots = await slotsOf(venue, 'Скуош');
    const free = (slots: typeof squashSlots, hhmm: string) =>
      slots.find((s) => clock(s.startTs) === hhmm)!.available;
    expect(['09:00', '09:15', '09:30', '09:45', '10:00'].map((h) => free(squashSlots, h))).toEqual([
      false,
      false,
      false,
      false,
      true,
    ]);

    // ── The desk: the whole track, 10:00–10:30, for a walk-in group ──
    const owner = await signInAs(db, {
      userId: ownerId,
      memberships: [{ tenantId: venue.tenantId, tenantSlug: SLUG, role: 'OWNER' }],
    });
    const deskRes = await deskRoute(
      new NextRequest(`http://t/api/v1/t/${SLUG}/admin/desk-bookings`, {
        method: 'POST',
        headers: {
          ...json,
          authorization: `Bearer ${owner.bearer}`,
          'idempotency-key': randomUUID(),
        },
        body: JSON.stringify({
          resourceId: trackId,
          date: DAY,
          startTime: '10:00',
          durationMinutes: 30,
          customer: { name: 'Фирмено парти', phone: '0888 123 456' },
        }),
      }),
      { params: Promise.resolve({ slug: SLUG }) },
    );
    const desk = (await deskRes.json()) as any;
    expect(deskRes.status).toBe(201);
    expect(desk.data).toMatchObject({
      status: 'CONFIRMED',
      channel: 'DESK',
      startTime: '10:00',
      endTime: '10:30',
      totalCents: 12000,
    });

    // ── A second group cannot have any of it: exclusive, like a court ──
    const clash = await book(p.bearer, trackId, '10:15', '10:30');
    expect(clash.status).toBe(409);
    expect(clash.body.error.code).toBe('SLOT_TAKEN');

    // ── The next free quarter is theirs ──
    const laps = await book(p.bearer, trackId, '10:30', '11:00');
    expect(laps.status).toBe(201);
    expect(laps.body.data).toMatchObject({
      totalCents: 12000,
      resource: { id: trackId, sport: 'KARTING', resourceType: 'TRACK' },
    });
    const trackSlots = await slotsOf(venue, 'Писта');
    expect(
      ['09:45', '10:00', '10:15', '10:30', '10:45', '11:00'].map((h) => free(trackSlots, h)),
    ).toEqual([true, false, false, false, false, true]);

    // ── The player's list names each kind, for "Корт" or "Писта" ──
    const mine = await myBookingsRoute(
      new NextRequest('http://t/api/v1/me/bookings', {
        headers: { authorization: `Bearer ${p.bearer}` },
      }),
      { params: Promise.resolve({}) },
    );
    const page = (await mine.json()) as {
      data: { items: Array<{ resource: { name: string; resourceType: string } }> };
    };
    expect(page.data.items.map((b) => [b.resource.name, b.resource.resourceType]).sort()).toEqual([
      ['Писта', 'TRACK'],
      ['Скуош', 'COURT'],
    ]);
  });
});

// ══ The courts screen ════════════════════════════════════════════════

describe('the courts screen (sport choice per court)', () => {
  it('a karting court is created as a TRACK; a change of sport moves the type with it', async () => {
    const { venue, ownerId, squashId } = await onboard();
    const base = {
      venueId: venue.id,
      surface: 'CONCRETE',
      isIndoor: true,
      capacity: 10,
      basePriceCents: 6000,
      minBookingMinutes: 15,
      maxBookingMinutes: 60,
      slotStepMinutes: 15,
    };

    // The form never sends a type: the sport decides.
    const input = courtCreateSchema.parse({ ...base, name: 'Писта 2', sport: 'KARTING' });
    expect(input.resourceType).toBe('TRACK');
    expect(
      courtCreateSchema.safeParse({ ...base, name: 'X', sport: 'TENNIS', resourceType: 'TRACK' })
        .success,
    ).toBe(false);

    const created = await runInTenantContext(venue.tenantId, (c) =>
      createCourt(c, venue.tenantId, ownerId, input),
    );
    expect(created).toMatchObject({ sport: 'KARTING', resourceType: 'TRACK' });

    const edit = { name: 'Писта 2', surface: 'WOOD', isIndoor: true, capacity: 2, basePriceCents: 1800, minBookingMinutes: 45, maxBookingMinutes: 90, slotStepMinutes: 15 } as const; // prettier-ignore
    const asSquash = await runInTenantContext(venue.tenantId, (c) =>
      updateCourt(c, venue.tenantId, ownerId, created.id, { ...edit, sport: 'SQUASH' }),
    );
    expect(asSquash).toMatchObject({ sport: 'SQUASH', resourceType: 'COURT' });

    const asKarting = await runInTenantContext(venue.tenantId, (c) =>
      updateCourt(c, venue.tenantId, ownerId, squashId, {
        ...edit,
        name: 'Скуош',
        sport: 'KARTING',
      }),
    );
    expect(asKarting).toMatchObject({ sport: 'KARTING', resourceType: 'TRACK' });
  });
});

// ══ The profile's sports and levels (#359) ════════════════════════════

describe('profile levels', () => {
  it('a player declares a squash level; karting has none, and PATCH /me refuses it', async () => {
    const p = await player();
    const patch = async (sports: unknown) => {
      const res = await patchMe(
        new NextRequest('http://t/api/v1/me', {
          method: 'PATCH',
          headers: { ...json, authorization: `Bearer ${p.bearer}` },
          body: JSON.stringify({ sports }),
        }),
        { params: Promise.resolve({}) },
      );
      return { status: res.status, body: (await res.json()) as any };
    };

    const squash = await patch([{ sport: 'SQUASH', level: 4 }]);
    expect(squash.status).toBe(200);
    expect(squash.body.data.sports).toEqual([{ sport: 'SQUASH', level: 4 }]);

    const karting = await patch([{ sport: 'KARTING', level: 3 }]);
    expect(karting.status).toBe(400);
    expect(karting.body.error.code).toBe('BAD_REQUEST');
    // Nothing was replaced by the refused list.
    expect(
      await db.playerSportLevel.findMany({ where: { userId: p.userId }, select: { sport: true } }),
    ).toEqual([{ sport: 'SQUASH' }]);
  });
});

// ══ The club's statement (#372) ══════════════════════════════════════

describe("the club's statement", () => {
  const header = async (tenantId: string) => {
    const statement = await loadClubStatement(db, tenantId, '2036-11');
    const csv = await statementCsv(statement!);
    return {
      nouns: statement!.courtNouns,
      columns: csv
        .replace(/^\uFEFF/, '')
        .split('\r\n')[0]!
        .split(';'),
    };
  };

  it('names its court column after what the club has: "Писта", or both', async () => {
    const both = await onboard();
    expect(await header(both.venue.tenantId)).toMatchObject({
      nouns: 'mixed',
      columns: expect.arrayContaining(['Корт / писта']),
    });
  });

  it('a karting club reads "Писта"', async () => {
    expect((await onboardClub(db, spec(rawSpec([TRACK])))).outcome).toBe('applied');
    const venue = await db.venue.findFirstOrThrow({
      where: { slug: 'p51-center' },
      select: { tenantId: true },
    });
    const { nouns, columns } = await header(venue.tenantId);
    expect(nouns).toBe('track');
    expect(columns[3]).toBe('Писта');
  });
});
