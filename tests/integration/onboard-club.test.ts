import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AccountKind, Role } from '@prisma/client';
import { NextRequest } from 'next/server';

import { POST as createBooking } from '@/app/api/v1/t/[slug]/bookings/route';
import { loadVenueAvailability } from '@/app-layer/usecases/venue-availability';
import { AUDIT_ACTIONS } from '@/lib/audit';
import { cityLabel, type CityKey } from '@/lib/geo/cities';

import bg from '../../messages/bg.json';
import {
  BASE_RULE_NAME,
  type ClubSpec,
  onboardClub,
  parseClubSpec,
} from '../../scripts/lib/club-onboarding';
import { signInAs } from '../helpers/auth';
import { prismaTestClient, seedTenant, tableNames } from '../helpers/db';

/**
 * THE CLUB ONBOARDING SCRIPT (#365), END TO END.
 *
 * The engine is driven in-process (`onboardClub`, exactly what the CLI calls)
 * so each case can read the rows it wrote; the command line itself — flags,
 * exit codes, the messages an operator reads — is spawned a few times at the
 * end. "Working" is judged by the app's own readers: the availability the
 * venue page renders and the price `POST …/bookings` charges, not by the
 * columns this script happened to write.
 */

const db = prismaTestClient();

/** A spec as JSON, before validation: tests break it on purpose. */
type Raw = any;

const EXAMPLE = JSON.parse(readFileSync('docs/onboarding/example-club.json', 'utf8')) as Record<
  string,
  unknown
>;

/** The example spec, with a fresh owner address so cases cannot collide. */
function exampleSpec(mutate?: (raw: Raw) => void): ClubSpec {
  const raw = structuredClone(EXAMPLE) as Raw;
  raw.club.owner.email = `owner-${randomUUID().slice(0, 8)}@example.com`;
  mutate?.(raw);
  const parsed = parseClubSpec(raw);
  if (!parsed.ok) throw new Error(parsed.errors.join('\n'));
  return parsed.spec;
}

const SLUG = 'example-sports-club';

// Monday 17 November 2036 and the Sunday before. Sofia is UTC+2 in November.
const MONDAY = { from: new Date('2036-11-16T22:00:00Z'), to: new Date('2036-11-17T22:00:00Z') };
const SUNDAY = { from: new Date('2036-11-15T22:00:00Z'), to: new Date('2036-11-16T22:00:00Z') };
const localClock = (d: Date) =>
  `${String((d.getUTCHours() + 2) % 24).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;

async function venueBySlug(slug: string) {
  return db.venue.findFirstOrThrow({
    where: { slug },
    select: { id: true, name: true, timezone: true, publicSlug: true, city: true, tenantId: true },
  });
}

async function slotsOf(venueSlug: string, courtName: string, day: { from: Date; to: Date }) {
  const v = await venueBySlug(venueSlug);
  const all = await loadVenueAvailability(db, {
    venue: { id: v.id, name: v.name, timezone: v.timezone },
    from: day.from,
    to: day.to,
  });
  const court = all.find((r) => r.resource.name === courtName);
  if (!court) throw new Error(`no court ${courtName}`);
  return court.slots;
}

/** Every user table's row count: what "wrote nothing" means. */
async function census(): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const t of tableNames(db)) {
    const [{ n }] = await db.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT count(*)::bigint AS n FROM "public"."${t}"`,
    );
    out[t] = Number(n);
  }
  return out;
}

async function account(kind: AccountKind | null): Promise<{ id: string; email: string }> {
  const email = `${String(kind).toLowerCase()}-${randomUUID().slice(0, 8)}@playerz.test`;
  const u = await db.user.create({ data: { email, accountKind: kind }, select: { id: true } });
  return { id: u.id, email };
}

const hold = (userId: string, tenantId: string, role: Role) =>
  db.tenantMembership.create({ data: { userId, tenantId, role, status: 'ACTIVE' } });

const clubExists = async () => (await db.venueOrg.findUnique({ where: { slug: SLUG } })) !== null;

// ══ A full spec ═══════════════════════════════════════════════════════

describe('a full spec creates a bookable club', () => {
  it('creates the club, its owner, both venues and four courts', async () => {
    const spec = exampleSpec();
    const result = await onboardClub(db, spec);
    expect(result.outcome).toBe('applied');

    const org = await db.venueOrg.findUniqueOrThrow({ where: { slug: SLUG } });
    expect(org).toMatchObject({
      name: 'Example Sports Club',
      contactEmail: 'hello@example.com',
      maxUpcomingOnlineBookings: 3,
    });

    // The owner: a CLUB account, no credential, OWNER of this club only.
    const owner = await db.user.findUniqueOrThrow({
      where: { email: spec.club.owner.email },
      select: { id: true, accountKind: true, passwordHash: true, name: true },
    });
    expect(owner).toMatchObject({ accountKind: 'CLUB', passwordHash: null, name: 'Example Owner' });
    expect(
      await db.tenantMembership.findMany({
        where: { userId: owner.id },
        select: { tenantId: true, role: true, status: true },
      }),
    ).toEqual([{ tenantId: org.id, role: 'OWNER', status: 'ACTIVE' }]);

    // Venues: the city is stored canonically, so the Bulgarian name shows —
    // the second one was written "София" in the spec.
    const padel = await venueBySlug('example-padel-center');
    const park = await venueBySlug('example-park');
    for (const v of [padel, park]) {
      expect(v.city).toBe('Sofia');
      expect(cityLabel((k: CityKey) => bg.cities[k], v.city)).toBe('София');
    }
    expect(padel.publicSlug).toBe('example-padel-center');
    expect(park.publicSlug).toBe('example-park');
    expect(
      await db.venue.findMany({
        where: { tenantId: org.id },
        select: { slug: true, cancellationCutoffHours: true, email: true, timezone: true },
        orderBy: { slug: 'asc' },
      }),
    ).toEqual([
      {
        slug: 'example-padel-center',
        cancellationCutoffHours: 24,
        email: 'hello@example.com',
        timezone: 'Europe/Sofia',
      },
      {
        slug: 'example-park',
        cancellationCutoffHours: 12,
        email: 'park@example.com',
        timezone: 'Europe/Sofia',
      },
    ]);

    // Courts: the grid, the durations, and the price PER UNIT.
    const courts = await db.resource.findMany({
      where: { tenantId: org.id },
      select: {
        name: true,
        sport: true,
        resourceType: true,
        isIndoor: true,
        capacity: true,
        basePriceCents: true,
        slotStepMinutes: true,
        minBookingMinutes: true,
        maxBookingMinutes: true,
        pricingRules: {
          select: {
            name: true,
            priority: true,
            conditionsJson: true,
            multiplier: true,
            fixedPriceCents: true,
          },
        },
      },
      orderBy: { name: 'asc' },
    });
    expect(courts.map(({ pricingRules: _, ...c }) => c)).toEqual([
      { name: 'Football 5', sport: 'FOOTBALL5', resourceType: 'FIELD', isIndoor: false, capacity: 10, basePriceCents: 6000, slotStepMinutes: 60, minBookingMinutes: 60, maxBookingMinutes: 120 },
      { name: 'Padel 1', sport: 'PADEL', resourceType: 'COURT', isIndoor: true, capacity: 4, basePriceCents: 4500, slotStepMinutes: 30, minBookingMinutes: 90, maxBookingMinutes: 180 },
      { name: 'Padel 2', sport: 'PADEL', resourceType: 'COURT', isIndoor: false, capacity: 4, basePriceCents: 3600, slotStepMinutes: 30, minBookingMinutes: 90, maxBookingMinutes: 180 },
      { name: 'Tennis 1', sport: 'TENNIS', resourceType: 'COURT', isIndoor: false, capacity: 4, basePriceCents: 2000, slotStepMinutes: 60, minBookingMinutes: 60, maxBookingMinutes: 120 },
    ]); // prettier-ignore
    for (const c of courts) {
      expect(c.pricingRules).toHaveLength(1);
      expect(c.pricingRules[0]).toMatchObject({
        name: BASE_RULE_NAME,
        priority: 0,
        conditionsJson: {},
        fixedPriceCents: null,
      });
      expect(Number(c.pricingRules[0]!.multiplier)).toBe(1);
    }

    // Every create is audited, as the system, with where it came from.
    const audits = await db.auditEntry.findMany({ where: { tenantId: org.id } });
    expect(audits.length).toBe(1 + 1 + 2 + 4); // club, owner, venues, courts
    for (const a of audits) {
      expect(a).toMatchObject({
        action: AUDIT_ACTIONS.CLUB_ONBOARDING_CREATED,
        actorType: 'SYSTEM',
      });
    }
  });

  it('the venue page offers the grid, durations and prices the spec describes', async () => {
    await onboardClub(db, exampleSpec());

    // Padel 1: 07:00–23:00, a start every 30 minutes, 90 or 180 minutes long.
    const padel1 = await slotsOf('example-padel-center', 'Padel 1', MONDAY);
    expect(padel1).toHaveLength(30); // 07:00 … 21:30
    expect(localClock(padel1[0]!.startTs)).toBe('07:00');
    expect(localClock(padel1[1]!.startTs)).toBe('07:30');
    expect(localClock(padel1.at(-1)!.startTs)).toBe('21:30');
    expect(padel1[0]!.priceCents).toBe(4500);
    expect(padel1[0]!.durations?.map((d) => [d.minutes, d.priceCents])).toEqual([
      [90, 4500],
      [180, 9000],
    ]);

    // Padel 2 has its own hours: 09:00–21:00, closed on Sunday.
    const padel2 = await slotsOf('example-padel-center', 'Padel 2', MONDAY);
    expect(localClock(padel2[0]!.startTs)).toBe('09:00');
    expect(localClock(padel2.at(-1)!.startTs)).toBe('19:30');
    expect(await slotsOf('example-padel-center', 'Padel 2', SUNDAY)).toEqual([]);
    expect(localClock((await slotsOf('example-padel-center', 'Padel 1', SUNDAY))[0]!.startTs)).toBe(
      '08:00',
    );

    // Tennis: hourly, with the Monday lunch break the spec gives the venue.
    const tennis = await slotsOf('example-park', 'Tennis 1', MONDAY);
    expect(tennis.map((s) => localClock(s.startTs))).toEqual([
      '08:00', '09:00', '10:00', '11:00',
      '14:00', '15:00', '16:00', '17:00', '18:00', '19:00', '20:00', '21:00',
    ]); // prettier-ignore
    expect(tennis[0]!.durations?.map((d) => [d.minutes, d.priceCents])).toEqual([
      [60, 2000],
      [120, 4000],
    ]);
    // 11:00 cannot run for two hours into the break.
    expect(tennis[3]!.durations?.map((d) => d.minutes)).toEqual([60]);
  });

  it('a player books a two-hour slot and is charged what the spec says', async () => {
    await onboardClub(db, exampleSpec());
    const tennis = await db.resource.findFirstOrThrow({
      where: { name: 'Tennis 1' },
      select: { id: true },
    });
    const player = await account('PLAYER');
    const { bearer } = await signInAs(db, { userId: player.id, memberships: [] });

    const url = `http://localhost:3000/api/v1/t/${SLUG}/bookings`;
    const res = await createBooking(
      new NextRequest(url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${bearer}`,
          'content-type': 'application/json',
          'idempotency-key': `k-${randomUUID()}`,
        },
        // 18:00–20:00 Sofia time.
        body: JSON.stringify({
          resourceId: tennis.id,
          startTs: '2036-11-17T16:00:00Z',
          endTs: '2036-11-17T18:00:00Z',
        }),
      }),
      { params: Promise.resolve({ slug: SLUG }) },
    );

    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { totalCents: number; status: string } };
    expect(body.data.totalCents).toBe(4000);
    expect(body.data.status).toBe('CONFIRMED');
  });
});

// ══ Re-running, adding, changing ══════════════════════════════════════

describe('re-running the spec', () => {
  it('the same spec again is a no-op that writes nothing', async () => {
    const spec = exampleSpec();
    await onboardClub(db, spec);
    const before = await census();

    const again = await onboardClub(db, spec);

    expect(again.outcome).toBe('no-op');
    expect(await census()).toEqual(before);
  });

  it('a venue or court added to the spec is added; one left out is not deleted', async () => {
    const first = exampleSpec((raw) => {
      raw.venues = [raw.venues[0]];
    });
    await onboardClub(db, first);
    expect(await db.venue.count()).toBe(1);

    const more = exampleSpec((raw) => {
      raw.club.owner.email = first.club.owner.email;
      raw.venues[0].courts.push({ ...raw.venues[0].courts[0], name: 'Padel 3' });
      raw.venues[1].courts = [raw.venues[1].courts[0]]; // the football pitch, left out
    });
    const result = await onboardClub(db, more);

    expect(result.outcome).toBe('applied');
    if (result.outcome !== 'applied') return;
    expect(result.items.map((i) => `${i.op} ${i.what}`)).toEqual([
      'create court', // Padel 3
      'create venue', // the park
      'create court', // its tennis court; the football pitch was left out
    ]);
    expect((await db.resource.findMany({ select: { name: true }, orderBy: { name: 'asc' } })).map((r) => r.name)).toEqual(
      ['Padel 1', 'Padel 2', 'Padel 3', 'Tennis 1'],
    ); // prettier-ignore

    // Dropping Padel 3 from the spec again deletes nothing.
    const fewer = exampleSpec((raw) => {
      raw.club.owner.email = first.club.owner.email;
    });
    await onboardClub(db, fewer);
    expect(await db.resource.count()).toBe(5);
  });

  it('a changed value is refused without --update, and nothing at all is written', async () => {
    const spec = exampleSpec();
    await onboardClub(db, spec);
    const before = await census();

    const changed = exampleSpec((raw) => {
      raw.club.owner.email = spec.club.owner.email;
      raw.club.maxUpcomingOnlineBookings = 5;
      raw.venues[1].courts[0].pricePerHourCents = 2200;
      raw.venues[1].hours.tue = ['09:00', '22:00'];
      // Something new rides along: it is not created either.
      raw.venues[1].courts.push({ ...raw.venues[1].courts[0], name: 'Tennis 2' });
    });
    const result = await onboardClub(db, changed);

    expect(result.outcome).toBe('needs-update');
    if (result.outcome !== 'needs-update') return;
    const changes = result.items.filter((i) => i.op === 'change');
    expect(changes.map((c) => [c.what, c.label, c.diffs?.map((d) => `${d.field}: ${d.from} → ${d.to}`)])).toEqual([
      ['club', 'club Example Sports Club (example-sports-club)', ['maxUpcomingOnlineBookings: 3 → 5']],
      ['court', 'court example-park / Tennis 1', ['price: €20.00/hour (basePriceCents 2000 per 60 min) → €22.00/hour (basePriceCents 2200 per 60 min)']],
      ['hours', expect.stringContaining('Tennis 1'), ['tue: 08:00–22:00 → 09:00–22:00']],
      ['hours', expect.stringContaining('Football 5'), ['tue: 08:00–22:00 → 09:00–22:00']],
    ]); // prettier-ignore
    expect(await census()).toEqual(before);
  });

  it('with --update the change is applied, from today, and audited — and the old hours are kept', async () => {
    const spec = exampleSpec();
    await onboardClub(db, spec);
    const changed = exampleSpec((raw) => {
      raw.club.owner.email = spec.club.owner.email;
      raw.venues[1].courts[0].pricePerHourCents = 2200;
      raw.venues[1].courts[0].hours = { ...raw.venues[1].hours, mon: ['10:00', '20:00'] };
    });

    // "Today" is Monday 10 November 2036, a week before the slots read below.
    const result = await onboardClub(db, changed, {
      update: true,
      operator: 'ops@playerz.test',
      specPath: 'club.json',
      now: new Date('2036-11-10T12:00:00Z'),
    });
    expect(result.outcome).toBe('applied');

    const tennis = await db.resource.findFirstOrThrow({
      where: { name: 'Tennis 1' },
      select: { id: true, basePriceCents: true, tenantId: true },
    });
    expect(tennis.basePriceCents).toBe(2200);

    // The old Monday rows are retired, not deleted, and the new ones start at
    // local midnight on the 10th.
    const rows = await db.resourceAvailability.findMany({
      where: { resourceId: tennis.id, dayOfWeek: 1 },
      select: { openTime: true, effectiveFrom: true, effectiveTo: true },
      orderBy: [{ createdAt: 'asc' }, { openTime: 'asc' }],
    });
    expect(rows).toEqual([
      { openTime: new Date('1970-01-01T08:00:00Z'), effectiveFrom: null, effectiveTo: new Date('2036-11-09T21:59:59.999Z') },
      { openTime: new Date('1970-01-01T14:00:00Z'), effectiveFrom: null, effectiveTo: new Date('2036-11-09T21:59:59.999Z') },
      { openTime: new Date('1970-01-01T10:00:00Z'), effectiveFrom: new Date('2036-11-09T22:00:00Z'), effectiveTo: null },
    ]); // prettier-ignore

    const next = await slotsOf('example-park', 'Tennis 1', MONDAY);
    expect(next.map((s) => localClock(s.startTs))).toEqual([
      '10:00', '11:00', '12:00', '13:00', '14:00', '15:00', '16:00', '17:00', '18:00', '19:00',
    ]); // prettier-ignore
    expect(next[0]!.priceCents).toBe(2200);
    // The Monday before "today" still had the old hours.
    const before = await slotsOf('example-park', 'Tennis 1', {
      from: new Date('2036-11-02T22:00:00Z'),
      to: new Date('2036-11-03T22:00:00Z'),
    });
    expect(localClock(before[0]!.startTs)).toBe('08:00');

    const audits = await db.auditEntry.findMany({
      where: { tenantId: tennis.tenantId, action: AUDIT_ACTIONS.CLUB_ONBOARDING_UPDATED },
      orderBy: { entity: 'asc' },
    });
    expect(audits.map((a) => a.entity)).toEqual(['Resource', 'ResourceAvailability']);
    for (const a of audits) {
      expect(a.actorType).toBe('SYSTEM');
      expect(a.detailsJson).toMatchObject({
        operator: 'ops@playerz.test',
        spec: 'club.json',
        source: 'scripts/onboard-club.ts',
      });
    }
    expect((audits[0]!.detailsJson as { diffs: unknown[] }).diffs).toEqual([
      expect.objectContaining({ field: 'price' }),
    ]);

    // And now the spec matches: running it again is a no-op.
    expect(
      (await onboardClub(db, changed, { now: new Date('2036-11-10T12:00:00Z') })).outcome,
    ).toBe('no-op');
  });

  it('a court made by create-venue-org gets its base pricing rule without --update', async () => {
    const spec = exampleSpec((raw) => {
      raw.venues = [raw.venues[1]];
      raw.venues[0].courts = [raw.venues[0].courts[0]];
    });
    await onboardClub(db, spec);
    await db.pricingRule.deleteMany({});

    const result = await onboardClub(db, spec);

    expect(result.outcome).toBe('applied');
    expect(await db.pricingRule.count({ where: { name: BASE_RULE_NAME } })).toBe(1);
  });
});

// ══ The owner (#263) ══════════════════════════════════════════════════

describe('the owner is a CLUB account of this club only', () => {
  const withOwner = (email: string) =>
    exampleSpec((raw) => {
      raw.club.owner.email = email;
    });

  it('refuses a PLAYER who plays somewhere, by name — and creates nothing', async () => {
    const elsewhere = await seedTenant({ name: 'Elsewhere' });
    const player = await account('PLAYER');
    await hold(player.id, elsewhere.tenantId, 'PLAYER');

    const result = await onboardClub(db, withOwner(player.email));

    expect(result).toEqual({
      outcome: 'refused',
      reason: expect.stringMatching(/is a PLAYER account/),
    });
    expect(await clubExists()).toBe(false);
    expect(await db.venue.count()).toBe(0);
  });

  it('refuses a COACH account and another club’s account', async () => {
    const coach = await account('COACH');
    expect(await onboardClub(db, withOwner(coach.email))).toMatchObject({
      outcome: 'refused',
      reason: expect.stringMatching(/is a COACH account/),
    });

    const other = await seedTenant({ name: 'Other' });
    expect(await onboardClub(db, withOwner(other.ownerEmail))).toMatchObject({
      outcome: 'refused',
      reason: expect.stringMatching(/club account of another club/),
    });
    expect(await clubExists()).toBe(false);
  });

  it('an existing account that holds nothing yet becomes CLUB, matched case-insensitively', async () => {
    const fresh = await account('PLAYER');

    const result = await onboardClub(db, withOwner(fresh.email.toUpperCase()));

    expect(result.outcome).toBe('applied');
    expect((await db.user.findUniqueOrThrow({ where: { id: fresh.id } })).accountKind).toBe('CLUB');
  });

  it('a different owner for an existing club is a change: refused, then added beside the first', async () => {
    const spec = exampleSpec();
    await onboardClub(db, spec);
    const second = withOwner(`second-${randomUUID().slice(0, 8)}@example.com`);

    expect((await onboardClub(db, second)).outcome).toBe('needs-update');

    expect(
      (await onboardClub(db, second, { update: true, operator: 'ops@playerz.test' })).outcome,
    ).toBe('applied');
    const owners = await db.tenantMembership.findMany({
      where: { role: 'OWNER', tenant: { slug: SLUG } },
      select: { user: { select: { email: true } } },
    });
    expect(owners.map((o) => o.user.email).sort()).toEqual(
      [spec.club.owner.email, second.club.owner.email].sort(),
    );
  });
});

// ══ The spec ══════════════════════════════════════════════════════════

describe('spec validation', () => {
  const errorsFor = (mutate: (raw: Raw) => void): string[] => {
    const raw = structuredClone(EXAMPLE) as Raw;
    mutate(raw);
    const parsed = parseClubSpec(raw);
    return parsed.ok ? [] : parsed.errors;
  };

  it('accepts the example', () => {
    expect(parseClubSpec(EXAMPLE).ok).toBe(true);
  });

  it.each<[string, (raw: Raw) => void, RegExp]>([
    [
      'a city the app cannot name',
      (r) => (r.venues[0].city = 'Atlantis'),
      /venues\[0\]\.city: is not a city/,
    ],
    [
      'swapped coordinates',
      (r) => ([r.venues[0].lat, r.venues[0].lng] = [23.32, 42.69]),
      /outside Bulgaria. Are lat and lng swapped/,
    ],
    ['a day left out', (r) => delete r.venues[0].hours.sun, /venues\[0\]\.hours\.sun: missing/],
    [
      'a time that is not HH:MM',
      (r) => (r.venues[0].hours.mon = ['7:00', '23:00']),
      /hours\.mon: .*HH:MM/,
    ],
    [
      'closing before opening',
      (r) => (r.venues[0].hours.mon = ['23:00', '07:00']),
      /opening must be before closing/,
    ],
    [
      'overlapping windows',
      (r) =>
        (r.venues[0].hours.mon = [
          ['08:00', '13:00'],
          ['12:00', '20:00'],
        ]),
      /overlap/,
    ],
    [
      'euros, not cents',
      (r) => (r.venues[0].courts[0].pricePerHourCents = 24.5),
      /pricePerHourCents: must be whole CENTS/,
    ],
    [
      'a price that does not divide into units',
      (r) => (r.venues[0].courts[0].pricePerHourCents = 3001),
      /not a whole number of cents per 90-minute unit/,
    ],
    [
      'a maximum that is not whole units',
      (r) => (r.venues[0].courts[0].maxBookingMinutes = 120),
      /maxBookingMinutes: must be a whole number of minBookingMinutes/,
    ],
    [
      'a step that does not divide the minimum',
      (r) => (r.venues[0].courts[0].slotStepMinutes = 60),
      /minBookingMinutes must be a whole number of slot steps/,
    ],
    [
      'a window shorter than the minimum',
      (r) => (r.venues[0].courts[1].hours.sat = ['09:00', '10:00']),
      /sat 09:00–10:00 is shorter than the 90-minute minimum/,
    ],
    ['an unknown sport', (r) => (r.venues[0].courts[0].sport = 'SQUASH'), /courts\[0\]\.sport/],
    [
      'a typo in a key',
      (r) => (r.venues[0].courts[0].pricePerHour = 1),
      /unknown key\(s\): pricePerHour/,
    ],
    [
      'a court named twice',
      (r) => (r.venues[0].courts[1].name = 'Padel 1'),
      /"Padel 1" appears twice/,
    ],
    ['a venue slug twice', (r) => (r.venues[1].slug = r.venues[0].slug), /appears twice; a venue/],
    [
      'a slug that is not a URL',
      (r) => (r.club.slug = 'Example Club'),
      /club\.slug: must be lower-case kebab/,
    ],
    [
      'a bad owner email',
      (r) => (r.club.owner.email = 'nobody'),
      /club\.owner\.email: is not an email/,
    ],
    [
      'a cutoff past a week',
      (r) => (r.club.cancellationCutoffHours = 200),
      /club\.cancellationCutoffHours/,
    ],
    [
      'no booking cap',
      (r) => delete r.club.maxUpcomingOnlineBookings,
      /club\.maxUpcomingOnlineBookings/,
    ],
    ['a venue with no courts', (r) => (r.venues[0].courts = []), /at least one court/],
  ])('refuses %s, saying where', (_name, mutate, expected) => {
    const errors = errorsFor(mutate);
    expect(errors.join('\n')).toMatch(expected);
  });
});

// ══ Dry run ═══════════════════════════════════════════════════════════

describe('--dry-run', () => {
  it('reports the whole club and writes nothing', async () => {
    const before = await census();

    const result = await onboardClub(db, exampleSpec(), { dryRun: true });

    expect(result.outcome).toBe('dry-run');
    if (result.outcome !== 'dry-run') return;
    expect(result.items.map((i) => `${i.op} ${i.what}`)).toEqual([
      'create club',
      'create owner',
      'create venue',
      'create court',
      'create court',
      'create venue',
      'create court',
      'create court',
    ]);
    expect(await census()).toEqual(before);
  });

  it('reports changes to an existing club, says they need --update, and writes nothing', async () => {
    const spec = exampleSpec();
    await onboardClub(db, spec);
    const before = await census();

    const result = await onboardClub(
      db,
      exampleSpec((raw) => {
        raw.club.owner.email = spec.club.owner.email;
        raw.venues[0].courts[0].capacity = 6;
      }),
      { dryRun: true },
    );

    expect(result).toMatchObject({
      outcome: 'dry-run',
      needsUpdate: true,
      items: [{ op: 'change', what: 'court', diffs: [{ field: 'capacity', from: '4', to: '6' }] }],
    });
    expect(await census()).toEqual(before);
  });
});

// ══ The command line ══════════════════════════════════════════════════

describe('onboard-club, as the command line it is', () => {
  const cli = (args: string[]): { code: number; out: string } => {
    try {
      const out = execFileSync('npx', ['tsx', 'scripts/onboard-club.ts', ...args], {
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
  };

  const specFile = (mutate?: (raw: Raw) => void) => {
    const raw = structuredClone(EXAMPLE) as Raw;
    raw.club.owner.email = `cli-${randomUUID().slice(0, 8)}@example.com`;
    mutate?.(raw);
    const path = join(tmpdir(), `365-spec-${randomUUID()}.json`);
    writeFileSync(path, JSON.stringify(raw));
    return path;
  };

  it('dry-runs, applies, and is a no-op the second time', () => {
    const path = specFile();

    const dry = cli(['--spec', path, '--dry-run']);
    expect(dry.code).toBe(0);
    expect(dry.out).toMatch(/DRY RUN for example-sports-club: nothing was written/);
    expect(dry.out).toMatch(/\+ court example-park \/ Tennis 1/);

    const apply = cli(['--spec', path]);
    expect(apply.code).toBe(0);
    expect(apply.out).toMatch(/\/venues\/example-padel-center/);
    expect(apply.out).toMatch(/\/clubs\/example-sports-club/);

    const again = cli(['--spec', path]);
    expect(again.code).toBe(0);
    expect(again.out).toMatch(/already exists\. Nothing written/);
  });

  it('refuses an invalid spec with every error, and a change without --update', async () => {
    const bad = cli([
      '--spec',
      specFile((r) => {
        r.venues[0].city = 'Atlantis';
        r.venues[0].courts[0].pricePerHourCents = 24.5;
      }),
    ]);
    expect(bad.code).toBe(1);
    expect(bad.out).toMatch(/is not a valid club spec\. Nothing was written/);
    expect(bad.out).toMatch(/venues\[0\]\.city/);
    expect(bad.out).toMatch(/venues\[0\]\.courts\[0\]\.pricePerHourCents/);
    expect(await clubExists()).toBe(false);

    const path = specFile();
    expect(cli(['--spec', path]).code).toBe(0);
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    raw.venues[0].courts[0].capacity = 6;
    writeFileSync(path, JSON.stringify(raw));

    const refused = cli(['--spec', path]);
    expect(refused.code).toBe(1);
    expect(refused.out).toMatch(/capacity: 4 {2}→ {2}6/);
    expect(refused.out).toMatch(/re-run with --update --operator/);

    const noOperator = cli(['--spec', path, '--update']);
    expect(noOperator.code).toBe(1);
    expect(noOperator.out).toMatch(/--update needs --operator/);

    expect(cli(['--spec', path, '--update', '--operator', 'ops@playerz.test']).code).toBe(0);
    expect((await db.resource.findFirstOrThrow({ where: { name: 'Padel 1' } })).capacity).toBe(6);
  });
});
