import { randomBytes } from 'node:crypto';

import type { BookingStatus, Prisma, PrismaClient, SportType } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { formatInTimeZone, fromZonedTime } from 'date-fns-tz';

import { CLUB_SLUG, CLUB_TIMEZONE, PERF_PASSWORD, PERSONAS } from './config';

/**
 * The data the navigation baseline is measured against, layered on top of
 * `scripts/seed.ts` (which must have run first: the two clubs, their owners,
 * their courts and one pricing rule per court come from there).
 *
 * ═══ WHY THE DEV SEED IS NOT ENOUGH ═══
 *
 * It has no player, no booking, no staff and no invite. Every club screen would
 * render its empty state and `/me/bookings` would say "no bookings". A baseline
 * taken against empty pages measures the cost of rendering nothing, and every
 * later change would "beat" it by also rendering nothing.
 *
 * ═══ WHAT "REALISTIC" MEANS HERE ═══
 *
 * A mid-size club on an ordinary day, not a stress test:
 *
 *   Sofia Padel Club   8 courts over two sites, 3 pricing rules each, 121
 *                      players, an owner, a manager, two front-desk staff, a
 *                      coach and two open invites. 45 days of history and 14
 *                      days ahead, at roughly half occupancy.
 *   Plovdiv            6 courts and 61 players, with the same shape of history.
 *   8 more clubs       so that /venues is a list and not just two cards.
 *   the player         24 bookings at BOTH clubs (past, upcoming and
 *                      cancelled) and one review. That fills the first page of
 *                      /me/bookings (20 rows), as an active player's list is.
 *
 * ═══ DETERMINISTIC, RELATIVE TO TODAY ═══
 *
 * Each court-day draws from its own fixed-seed PRNG, keyed by the court's
 * position and the day's offset from the club's today, and occupancy ignores
 * the weekday. So "today" holds the same bookings whether a run happens on a
 * Tuesday or a Saturday, and two runs a month apart measure the same pages.
 *
 * One thing is NOT fixed, and it cannot be without faking the clock: which of
 * today's bookings have already STARTED depends on the time of day. That
 * decides their status (COMPLETED vs CONFIRMED) and whether the diary offers
 * the no-show control on them. The run records its local start time, and
 * `compare.ts` warns when two runs started hours apart.
 */

/** mulberry32: tiny, fast and repeatable, which is the only property that matters here. */
function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// prettier-ignore
const MALE_FIRST = ['Георги', 'Иван', 'Димитър', 'Николай', 'Петър', 'Александър', 'Стефан', 'Мартин', 'Христо', 'Васил', 'Калоян', 'Борислав'];
// prettier-ignore
const FEMALE_FIRST = ['Мария', 'Елена', 'Иванка', 'Десислава', 'Надежда', 'Виктория', 'Габриела', 'Радостина', 'Теодора', 'Милена', 'Симона', 'Яна'];
// prettier-ignore
const SURNAMES = ['Иванов', 'Петров', 'Георгиев', 'Димитров', 'Николов', 'Стоянов', 'Тодоров', 'Христов', 'Илиев', 'Атанасов', 'Василев', 'Колев'];
// prettier-ignore
const GUESTS = ['Гост Павлов', 'Гост Маринова', 'Корпоративен турнир', 'Гост Janssen', 'Гост Костов', 'Училище №7'];
const TAGS = ['редовен', 'VIP', 'треньорски клиент', 'лига'];

function personName(i: number): string {
  const female = i % 2 === 1;
  const first = (female ? FEMALE_FIRST : MALE_FIRST)[i % 12]!;
  const last = SURNAMES[Math.floor(i / 2) % 12]!;
  return `${first} ${female ? `${last}а` : last}`;
}

interface ExtraClub {
  slug: string;
  name: string;
  city: string;
  lat: number;
  lng: number;
  sport: SportType;
  courts: number;
  basePriceCents: number;
  avgRating: number;
  reviewCount: number;
}

// prettier-ignore
const EXTRA_CLUBS: ExtraClub[] = [
  { slug: 'varna-beach-padel', name: 'Varna Beach Padel', city: 'Varna', lat: 43.2141, lng: 27.9147, sport: 'PADEL', courts: 4, basePriceCents: 2200, avgRating: 4.4, reviewCount: 31 },
  { slug: 'burgas-tennis-academy', name: 'Burgas Tennis Academy', city: 'Burgas', lat: 42.5048, lng: 27.4626, sport: 'TENNIS', courts: 5, basePriceCents: 2600, avgRating: 4.1, reviewCount: 18 },
  { slug: 'ruse-padel-arena', name: 'Ruse Padel Arena', city: 'Ruse', lat: 43.8356, lng: 25.9657, sport: 'PADEL', courts: 3, basePriceCents: 2000, avgRating: 4.6, reviewCount: 12 },
  { slug: 'stara-zagora-tennis-park', name: 'Stara Zagora Tennis Park', city: 'Stara Zagora', lat: 42.4258, lng: 25.6345, sport: 'TENNIS', courts: 4, basePriceCents: 2200, avgRating: 3.9, reviewCount: 9 },
  { slug: 'pleven-sports-hall', name: 'Pleven Sports Hall', city: 'Pleven', lat: 43.417, lng: 24.6067, sport: 'BADMINTON', courts: 6, basePriceCents: 1400, avgRating: 4.2, reviewCount: 22 },
  { slug: 'veliko-tarnovo-tennis', name: 'Veliko Tarnovo Tennis Club', city: 'Veliko Tarnovo', lat: 43.0757, lng: 25.6172, sport: 'TENNIS', courts: 3, basePriceCents: 2400, avgRating: 4.7, reviewCount: 27 },
  { slug: 'sofia-pickleball-hub', name: 'Sofia Pickleball Hub', city: 'Sofia', lat: 42.6629, lng: 23.3736, sport: 'PICKLEBALL', courts: 4, basePriceCents: 1800, avgRating: 4.5, reviewCount: 15 },
  { slug: 'lozenets-tennis-courts', name: 'Lozenets Tennis Courts', city: 'Sofia', lat: 42.6755, lng: 23.3207, sport: 'TENNIS', courts: 6, basePriceCents: 3200, avgRating: 4.3, reviewCount: 40 },
];

const OPEN_HOUR = 9;
const CLOSE_HOUR = 22;
const HISTORY_DAYS = 45;
const AHEAD_DAYS = 14;

const timeOfDay = (hour: number) => new Date(Date.UTC(1970, 0, 1, hour, 0, 0));

/** `2026-09-29` shifted by whole days, through UTC so month ends roll over. */
function shiftDay(isoDay: string, delta: number): string {
  const [y, m, d] = isoDay.split('-').map((n) => Number.parseInt(n, 10));
  return new Date(Date.UTC(y!, m! - 1, d! + delta)).toISOString().slice(0, 10);
}

/** A wall-clock time at the club, as an instant. */
function atClub(isoDay: string, minutes: number): Date {
  const hh = String(Math.floor(minutes / 60)).padStart(2, '0');
  const mm = String(minutes % 60).padStart(2, '0');
  return fromZonedTime(`${isoDay}T${hh}:${mm}:00`, CLUB_TIMEZONE);
}

interface Court {
  id: string;
  tenantId: string;
  basePriceCents: number;
}

interface PlannedBooking {
  court: Court;
  day: number;
  startMin: number;
  durationMin: number;
  userId: string | null;
  /** Drawn once per booking from its court-day's stream, so status is repeatable too. */
  draw: number;
  /** The persona's statuses are fixed; everyone else's follow from `now`. */
  status?: BookingStatus;
}

export interface PerfSeedSummary {
  clubs: number;
  courts: number;
  players: number;
  bookings: number;
  bookingsTodayAtClub: number;
  personaBookings: number;
}

export async function seedPerfFixture(db: PrismaClient, now: Date): Promise<PerfSeedSummary> {
  const today = formatInTimeZone(now, CLUB_TIMEZONE, 'yyyy-MM-dd');
  const passwordHash = await bcrypt.hash(PERF_PASSWORD, 10);

  return db.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL ROLE app_superuser`);

      const sofia = await tx.venueOrg.findUniqueOrThrow({ where: { slug: CLUB_SLUG } });
      const plovdiv = await tx.venueOrg.findUniqueOrThrow({
        where: { slug: 'plovdiv-tennis-center' },
      });
      const owner = await tx.user.findUniqueOrThrow({ where: { email: PERSONAS.staff.email } });

      // ── Sofia's second site. A club's courts may sit at more than one venue,
      //    and the diary labels each column with its venue only when they do.
      const mladost = await tx.venue.create({
        data: {
          tenantId: sofia.id,
          slug: 'sofia-padel-club-mladost',
          name: 'Sofia Padel Club Младост',
          addressLine: 'Младост 4, ул. Проф. Александър Фол 2',
          city: 'Sofia',
          country: 'BG',
          lat: 42.6264,
          lng: 23.3794,
          email: sofia.contactEmail,
        },
      });
      const secondSite = [
        {
          name: 'Court 5',
          sport: 'PADEL',
          surface: 'ARTIFICIAL_GRASS',
          isIndoor: true,
          price: 2800,
        },
        {
          name: 'Court 6',
          sport: 'PADEL',
          surface: 'ARTIFICIAL_GRASS',
          isIndoor: true,
          price: 2800,
        },
        { name: 'Court 7', sport: 'TENNIS', surface: 'HARD', isIndoor: false, price: 2600 },
        { name: 'Court 8', sport: 'TENNIS', surface: 'HARD', isIndoor: false, price: 2600 },
      ] as const;
      for (const c of secondSite) {
        const court = await tx.resource.create({
          data: {
            tenantId: sofia.id,
            venueId: mladost.id,
            name: c.name,
            sport: c.sport,
            surface: c.surface,
            isIndoor: c.isIndoor,
            basePriceCents: c.price,
          },
        });
        await tx.resourceAvailability.createMany({
          data: Array.from({ length: 7 }, (_, dayOfWeek) => ({
            tenantId: sofia.id,
            resourceId: court.id,
            dayOfWeek,
            openTime: timeOfDay(OPEN_HOUR),
            closeTime: timeOfDay(CLOSE_HOUR),
          })),
        });
        // The rule scripts/seed.ts gives every court it creates.
        await tx.pricingRule.create({
          data: {
            tenantId: sofia.id,
            resourceId: court.id,
            name: 'Weekend peak',
            priority: 200,
            conditionsJson: { dayOfWeek: [0, 6], timeRange: { from: '18:00', to: '22:00' } },
            multiplier: 1.5,
          },
        });
      }

      // Ordered by site and name, which is also the order the screens use, so
      // "the third court" means the same court on every run.
      const courtsOf = (tenantId: string): Promise<Court[]> =>
        tx.resource.findMany({
          where: { tenantId },
          select: { id: true, tenantId: true, basePriceCents: true },
          orderBy: [{ venueId: 'asc' }, { name: 'asc' }],
        });
      const sofiaCourts = await courtsOf(sofia.id);
      const plovdivCourts = await courtsOf(plovdiv.id);

      // ── Two more rules per court, so the pricing screen has something to
      //    explain: a weekday evening peak and a morning discount.
      for (const c of [...sofiaCourts, ...plovdivCourts]) {
        await tx.pricingRule.createMany({
          data: [
            {
              tenantId: c.tenantId,
              resourceId: c.id,
              name: 'Weekday evening peak',
              priority: 150,
              conditionsJson: {
                dayOfWeek: [1, 2, 3, 4, 5],
                timeRange: { from: '18:00', to: '22:00' },
              },
              multiplier: 1.25,
            },
            {
              tenantId: c.tenantId,
              resourceId: c.id,
              name: 'Morning off-peak',
              priority: 120,
              conditionsJson: { timeRange: { from: '09:00', to: '12:00' } },
              multiplier: 0.8,
            },
          ],
        });
      }

      // ── More clubs, so that public discovery is a list.
      for (const x of EXTRA_CLUBS) {
        const org = await tx.venueOrg.create({
          data: {
            slug: x.slug,
            name: x.name,
            city: x.city,
            country: 'BG',
            contactEmail: `hello@${x.slug}.test`,
          },
        });
        const venue = await tx.venue.create({
          data: {
            tenantId: org.id,
            slug: x.slug,
            name: x.name,
            addressLine: `${x.city} Center`,
            city: x.city,
            country: 'BG',
            lat: x.lat,
            lng: x.lng,
            email: org.contactEmail,
            avgRating: x.avgRating,
            reviewCount: x.reviewCount,
          },
        });
        await tx.resource.createMany({
          data: Array.from({ length: x.courts }, (_, i) => ({
            tenantId: org.id,
            venueId: venue.id,
            name: `Court ${i + 1}`,
            sport: x.sport,
            surface: x.sport === 'TENNIS' ? ('CLAY' as const) : ('HARD' as const),
            isIndoor: i % 2 === 0,
            basePriceCents: x.basePriceCents,
          })),
        });
      }

      // ── Staff at Sofia: one account each, at one club each.
      // One kind per account (#263), which the database enforces with a
      // trigger: club roles need a CLUB account and a coach a COACH one.
      const staff = [
        { email: 'manager@sofia.bg', name: 'Надежда Колева', role: 'MANAGER', kind: 'CLUB' },
        { email: 'reception1@sofia.bg', name: 'Симона Илиева', role: 'STAFF', kind: 'CLUB' },
        { email: 'reception2@sofia.bg', name: 'Калоян Тодоров', role: 'STAFF', kind: 'CLUB' },
        { email: 'coach@sofia.bg', name: 'Борислав Атанасов', role: 'COACH', kind: 'COACH' },
      ] as const;
      for (const s of staff) {
        const u = await tx.user.create({
          data: { email: s.email, name: s.name, emailVerified: now, accountKind: s.kind },
        });
        await tx.tenantMembership.create({
          data: {
            userId: u.id,
            tenantId: sofia.id,
            role: s.role,
            status: 'ACTIVE',
            acceptedAt: now,
            invitedById: owner.id,
          },
        });
      }
      const inviteTtl = (days: number) => new Date(now.getTime() + days * 864e5);
      await tx.invite.createMany({
        data: [
          { email: 'new.coach@sofia.bg', role: 'COACH' as const, expiresAt: inviteTtl(6) },
          { email: 'weekend.desk@sofia.bg', role: 'STAFF' as const, expiresAt: inviteTtl(3) },
        ].map((i) => ({
          ...i,
          tenantId: sofia.id,
          invitedById: owner.id,
          tokenHash: randomBytes(32).toString('hex'),
        })),
      });

      // ── The player persona and a pool of players. 0..119 play at Sofia and
      //    90..149 at Plovdiv, so thirty play at both.
      const persona = await tx.user.create({
        data: {
          email: PERSONAS.player.email,
          name: PERSONAS.player.name,
          passwordHash,
          emailVerified: now,
          accountKind: 'PLAYER',
          profile: {
            create: {
              displayName: PERSONAS.player.name,
              sports: ['PADEL', 'TENNIS'],
              skillLevel: 'INTERMEDIATE',
            },
          },
        },
      });

      const POOL = 150;
      const poolIds: string[] = [];
      for (let i = 0; i < POOL; i++) {
        const name = personName(i);
        const u = await tx.user.create({
          data: {
            email: `p${i}@perf.playerz.test`,
            name,
            emailVerified: now,
            accountKind: 'PLAYER',
            profile: { create: { displayName: name, sports: i < 90 ? ['PADEL'] : ['TENNIS'] } },
          },
          select: { id: true },
        });
        poolIds.push(u.id);
      }
      const sofiaPlayers = poolIds.slice(0, 120);
      const plovdivPlayers = poolIds.slice(90, 150);

      // Booking at a club makes you a member of it (#229), so every player in
      // a club's pool holds an ACTIVE PLAYER membership there.
      const joined = (tenantId: string, ids: string[]) =>
        ids.map((userId) => ({
          userId,
          tenantId,
          role: 'PLAYER' as const,
          status: 'ACTIVE' as const,
          acceptedAt: now,
        }));
      await tx.tenantMembership.createMany({
        data: [
          ...joined(sofia.id, [...sofiaPlayers, persona.id]),
          ...joined(plovdiv.id, [...plovdivPlayers, persona.id]),
        ],
      });

      // ── Bookings. The persona's go in first; each court-day is then filled
      //    around them.
      const planned: PlannedBooking[] = [];
      const taken = new Map<string, Array<[number, number]>>();
      const occupy = (courtId: string, day: number, a: number, b: number) => {
        const key = `${courtId}:${day}`;
        taken.set(key, [...(taken.get(key) ?? []), [a, b]]);
      };
      const free = (courtId: string, day: number, a: number, b: number) =>
        !(taken.get(`${courtId}:${day}`) ?? []).some(([x, y]) => a < y && x < b);

      const done = 'COMPLETED' as const;
      const ahead = 'CONFIRMED' as const;
      const personaPlan: Array<{
        courts: Court[];
        day: number;
        start: number;
        dur: number;
        status: BookingStatus;
      }> = [
        // Sofia, padel, evenings: ten played, one cancelled, three ahead.
        ...[-44, -40, -36, -33, -29, -26, -22, -19, -12, -5].map((day) => ({
          courts: sofiaCourts,
          day,
          start: 19 * 60,
          dur: 90,
          status: done,
        })),
        { courts: sofiaCourts, day: -9, start: 18 * 60, dur: 90, status: 'CANCELLED' },
        { courts: sofiaCourts, day: 2, start: 19 * 60, dur: 90, status: ahead },
        { courts: sofiaCourts, day: 6, start: 20 * 60, dur: 90, status: ahead },
        { courts: sofiaCourts, day: 9, start: 18 * 60 + 30, dur: 90, status: ahead },
        // Plovdiv, tennis, mornings: seven played, one cancelled, two ahead.
        ...[-37, -30, -27, -23, -16, -8, -4].map((day) => ({
          courts: plovdivCourts,
          day,
          start: 10 * 60,
          dur: 60,
          status: done,
        })),
        { courts: plovdivCourts, day: -3, start: 17 * 60, dur: 60, status: 'CANCELLED' },
        { courts: plovdivCourts, day: 4, start: 10 * 60, dur: 60, status: ahead },
        { courts: plovdivCourts, day: 11, start: 11 * 60, dur: 60, status: ahead },
      ];
      personaPlan.forEach((p, i) => {
        // The first four courts of each club: Sofia's main site, all padel.
        const court = p.courts[i % 4]!;
        planned.push({
          court,
          day: p.day,
          startMin: p.start,
          durationMin: p.dur,
          userId: persona.id,
          draw: 0,
          status: p.status,
        });
        occupy(court.id, p.day, p.start, p.start + p.dur);
      });
      const personaBookings = planned.length;

      for (const [club, courts, ids] of [
        [1, sofiaCourts, sofiaPlayers],
        [2, plovdivCourts, plovdivPlayers],
      ] as const) {
        courts.forEach((court, courtIndex) => {
          for (let day = -HISTORY_DAYS; day <= AHEAD_DAYS; day++) {
            const rand = prng(club * 1_000_003 + courtIndex * 10_007 + (day + 1000) * 101);
            // Regulars book far more than the tail: the product of two uniform
            // draws skews the pick toward the front of the pool.
            const pick = () => ids[Math.floor(rand() * rand() * ids.length)]!;
            for (let t = OPEN_HOUR * 60; t < CLOSE_HOUR * 60;) {
              const p = t < 12 * 60 ? 0.3 : t < 17 * 60 ? 0.4 : 0.8;
              const dur = rand() < 0.65 ? 60 : 90;
              if (t + dur <= CLOSE_HOUR * 60 && rand() < p && free(court.id, day, t, t + dur)) {
                const userId = rand() < 0.72 ? pick() : null;
                planned.push({ court, day, startMin: t, durationMin: dur, userId, draw: rand() });
                occupy(court.id, day, t, t + dur);
                t += dur;
              } else {
                t += 30;
              }
            }
          }
        });
      }

      const rows: Prisma.BookingCreateManyInput[] = planned.map((b, i) => {
        const isoDay = shiftDay(today, b.day);
        const startTs = atClub(isoDay, b.startMin);
        const endTs = atClub(isoDay, b.startMin + b.durationMin);
        const r = b.draw;
        const status: BookingStatus =
          b.status ??
          (endTs <= now
            ? r < 0.93
              ? 'COMPLETED'
              : r < 0.98
                ? 'CANCELLED'
                : 'NO_SHOW'
            : startTs > now
              ? r < 0.9
                ? 'CONFIRMED'
                : r < 0.94
                  ? 'PENDING'
                  : 'CANCELLED'
              : 'CONFIRMED');
        const multiplier = b.startMin >= 18 * 60 ? 1.25 : b.startMin < 12 * 60 ? 0.8 : 1;
        const guest = b.userId ? null : GUESTS[i % GUESTS.length]!;
        return {
          tenantId: b.court.tenantId,
          resourceId: b.court.id,
          startTs,
          endTs,
          bookedByUserId: b.userId,
          guestName: guest,
          guestPhone: guest ? `+35988${String(1_000_000 + i).slice(-7)}` : null,
          status,
          totalCents:
            Math.round((b.court.basePriceCents * (b.durationMin / 60) * multiplier) / 100) * 100,
          currency: 'EUR',
          idempotencyKey: `perf-${b.court.id}-${b.day}-${b.startMin}`,
          expiresAt: status === 'PENDING' ? new Date(now.getTime() + 90 * 60_000) : null,
          cancelledAt: status === 'CANCELLED' ? new Date(startTs.getTime() - 864e5) : null,
        };
      });
      for (let i = 0; i < rows.length; i += 1000) {
        await tx.booking.createMany({ data: rows.slice(i, i + 1000) });
      }

      // ── The club's view of each player: last played, no-shows, a few tags.
      const standing = new Map<
        string,
        { tenantId: string; userId: string; last: Date | null; noShows: number }
      >();
      for (const b of rows) {
        if (!b.bookedByUserId) continue;
        const key = `${b.tenantId}:${b.bookedByUserId}`;
        const s = standing.get(key) ?? {
          tenantId: b.tenantId,
          userId: b.bookedByUserId,
          last: null,
          noShows: 0,
        };
        const end = b.endTs as Date;
        if (b.status === 'COMPLETED' && (!s.last || end > s.last)) s.last = end;
        if (b.status === 'NO_SHOW') s.noShows++;
        standing.set(key, s);
      }
      await tx.playerVenueRelationship.createMany({
        data: [...standing.values()].map((s, i) => ({
          tenantId: s.tenantId,
          playerUserId: s.userId,
          lastPlayedAt: s.last,
          noShowCount: s.noShows,
          tags: i % 7 === 0 ? [TAGS[i % TAGS.length]!] : i % 11 === 0 ? [TAGS[0]!, TAGS[3]!] : [],
        })),
      });

      // Membership levels and a little credit, for the players screen.
      await tx.membership.createMany({
        data: sofiaPlayers.slice(0, 25).map((playerUserId, i) => ({
          tenantId: sofia.id,
          playerUserId,
          level: i % 3 === 0 ? 'Gold' : 'Silver',
          priceCents: i % 3 === 0 ? 9900 : 5900,
          startsAt: new Date(now.getTime() - 60 * 864e5),
          endsAt: new Date(now.getTime() + 300 * 864e5),
        })),
      });
      await tx.creditLedgerEntry.createMany({
        data: sofiaPlayers.slice(5, 20).map((userId, i) => ({
          tenantId: sofia.id,
          userId,
          deltaCents: (i + 1) * 500,
          reason: i % 2 === 0 ? ('REFUND_CREDIT' as const) : ('ADMIN_ADJUST' as const),
          balanceAfterCents: (i + 1) * 500,
        })),
      });

      // ── Reviews. The persona reviewed Sofia after its latest visit, so its
      //    other Sofia visits say so; it has not reviewed Plovdiv, so its
      //    Plovdiv visits offer the form. Other players' reviews make the
      //    ratings on /venues real ones.
      const venueOf = (tenantId: string, slug: string) =>
        tx.venue.findUniqueOrThrow({ where: { tenantId_slug: { tenantId, slug } } });
      const sofiaVenue = await venueOf(sofia.id, CLUB_SLUG);
      const plovdivVenue = await venueOf(plovdiv.id, 'plovdiv-tennis-center');
      const reviewed = await tx.booking.findFirstOrThrow({
        where: { bookedByUserId: persona.id, tenantId: sofia.id, status: 'COMPLETED' },
        orderBy: { startTs: 'desc' },
        select: { id: true },
      });
      await tx.review.create({
        data: {
          tenantId: sofia.id,
          venueId: sofiaVenue.id,
          authorUserId: persona.id,
          rating: 5,
          body: 'Страхотни кортове, лесно паркиране.',
          bookingId: reviewed.id,
          status: 'PUBLISHED',
        },
      });
      const reviewers = [
        ...sofiaPlayers
          .slice(0, 18)
          .map((u) => ({ u, tenantId: sofia.id, venueId: sofiaVenue.id })),
        ...plovdivPlayers
          .slice(30, 42)
          .map((u) => ({ u, tenantId: plovdiv.id, venueId: plovdivVenue.id })),
      ];
      await tx.review.createMany({
        data: reviewers.map((r, i) => ({
          tenantId: r.tenantId,
          venueId: r.venueId,
          authorUserId: r.u,
          rating: [5, 4, 5, 3, 4, 5][i % 6]!,
          body: i % 3 === 0 ? 'Добро осветление вечер.' : null,
          status: 'PUBLISHED' as const,
        })),
      });
      for (const v of [sofiaVenue, plovdivVenue]) {
        const agg = await tx.review.aggregate({
          where: { venueId: v.id, status: 'PUBLISHED' },
          _avg: { rating: true },
          _count: { _all: true },
        });
        await tx.venue.update({
          where: { id: v.id },
          data: {
            avgRating: Math.round((agg._avg.rating ?? 0) * 10) / 10,
            reviewCount: agg._count._all,
          },
        });
      }

      const bookingsTodayAtClub = rows.filter(
        (b) =>
          b.tenantId === sofia.id &&
          formatInTimeZone(b.startTs as Date, CLUB_TIMEZONE, 'yyyy-MM-dd') === today,
      ).length;

      return {
        clubs: 2 + EXTRA_CLUBS.length,
        courts:
          sofiaCourts.length + plovdivCourts.length + EXTRA_CLUBS.reduce((n, x) => n + x.courts, 0),
        players: POOL + 1,
        bookings: rows.length,
        bookingsTodayAtClub,
        personaBookings,
      };
    },
    { timeout: 180_000, maxWait: 10_000 },
  );
}
