import {
  CourtSurface,
  type Prisma,
  type PrismaClient,
  ResourceType,
  SportType,
} from '@prisma/client';
import { fromZonedTime, toZonedTime } from 'date-fns-tz';
import { z } from 'zod';

import { appendAuditEntries, AUDIT_ACTIONS, type AuditInput } from '@/lib/audit';
import { canonicalCity, CITY_SPELLINGS, cityKey } from '@/lib/geo/cities';

import {
  assignOwner,
  clockOf,
  decideOwner,
  HHMM,
  normaliseEmail,
  OwnerRefusedError,
  timeOfDay,
} from './onboarding-common';

/**
 * Onboarding a pilot club from a JSON spec (#365). The engine behind
 * `scripts/onboard-club.ts`; the reasons it is a script at all are in
 * `create-venue-org.ts` and `onboarding-common.ts`.
 *
 * ═══ ONE WALK, TWO MODES ═══
 *
 * `walk` goes through the spec — club, owner, each venue, each court — reads
 * what exists, and records what it would create or change. With `write` it
 * also does it. The dry run, the "this needs --update" refusal and the apply
 * are therefore the same code reading the same rows: what `--dry-run` prints
 * is what the apply does, not a second implementation's guess at it. The
 * apply walks again inside its transaction, so a row that changed between the
 * two is seen.
 *
 * ═══ CREATE, NEVER SILENTLY EDIT, NEVER DELETE ═══
 *
 * Missing things are created. Things that exist with other values are
 * REPORTED, and applied only with `--update` — `create-venue-org` refused to
 * let a create script quietly become an edit script, and this keeps that.
 * Nothing the spec leaves out is touched: a venue or court missing from the
 * spec stays, an optional field left out keeps its value. Changed opening
 * hours retire the old rows (`effectiveTo`) rather than deleting them.
 *
 * ═══ PRICE: PER HOUR IN THE SPEC, PER UNIT IN THE DATABASE ═══
 *
 * `Resource.basePriceCents` is the price of ONE `minBookingMinutes` block, not
 * of an hour (see `quoteBooking`). A club quotes an hourly price, so the spec
 * takes `pricePerHourCents` and this converts — and refuses a price that does
 * not divide into whole cents per unit, rather than rounding the club's price.
 */

// ═══ THE SPEC ═══════════════════════════════════════════════════════

/** In `dayOfWeek` order: 0 = Sunday … 6 = Saturday, as `ResourceAvailability` stores it. */
export const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
export type DayKey = (typeof DAY_KEYS)[number];

/** Venue-local minutes from midnight, [open, close). */
export type Window = readonly [number, number];
export type WeekHours = Record<DayKey, Window[]>;

const minutes = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h! * 60 + m!;
};
const hhmm = (mins: number) =>
  `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;

const DAY_SHAPE =
  'null (closed), ["HH:MM","HH:MM"] (open–close), or a list of such pairs for a day with a break';

/**
 * One day's opening hours. Parsed by hand rather than as a `z.union`, whose
 * error for `["7:00","23:00"]` is "Invalid input" against every branch — not
 * something an operator can fix from.
 */
const dayHours = z.unknown().transform((raw, ctx): Window[] => {
  if (raw === undefined) {
    ctx.addIssue({
      code: 'custom',
      message: 'missing. Every day is stated, even a closed one: write null for a closed day',
    });
    return z.NEVER;
  }
  if (raw === null) return [];

  const isPair = (x: unknown): x is [unknown, unknown] => Array.isArray(x) && x.length === 2;
  const pairs: unknown[] =
    isPair(raw) && typeof raw[0] === 'string' ? [raw] : Array.isArray(raw) ? raw : [];
  if (pairs.length === 0) {
    ctx.addIssue({ code: 'custom', message: `must be ${DAY_SHAPE}` });
    return z.NEVER;
  }

  const out: Window[] = [];
  for (const p of pairs) {
    if (!isPair(p) || typeof p[0] !== 'string' || typeof p[1] !== 'string') {
      ctx.addIssue({ code: 'custom', message: `must be ${DAY_SHAPE}` });
      return z.NEVER;
    }
    const [open, close] = p as [string, string];
    if (!HHMM.test(open) || !HHMM.test(close)) {
      // 24:00 is not HH:MM here: a `time` column round-trips it as 00:00, and
      // a club "open until 00:00" would then be open zero hours.
      ctx.addIssue({
        code: 'custom',
        message: `"${open}"–"${close}": times are HH:MM, 24-hour, 00:00–23:59 (e.g. "07:00")`,
      });
      return z.NEVER;
    }
    if (minutes(open) >= minutes(close)) {
      ctx.addIssue({
        code: 'custom',
        message: `${open}–${close}: opening must be before closing (a day cannot run past midnight)`,
      });
      return z.NEVER;
    }
    out.push([minutes(open), minutes(close)]);
  }

  out.sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < out.length; i++) {
    if (out[i]![0] < out[i - 1]![1]) {
      ctx.addIssue({
        code: 'custom',
        message: `${hhmm(out[i - 1]![0])}–${hhmm(out[i - 1]![1])} and ${hhmm(out[i]![0])}–${hhmm(out[i]![1])} overlap`,
      });
      return z.NEVER;
    }
  }
  return out;
});

/** Every day stated, none defaulted: a default is a club open when the script's author guessed. */
const weekHours = z.strictObject({
  mon: dayHours,
  tue: dayHours,
  wed: dayHours,
  thu: dayHours,
  fri: dayHours,
  sat: dayHours,
  sun: dayHours,
});

const slug = z
  .string()
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'must be lower-case kebab (e.g. "sofia-padel"): it is a URL');

const email = z.email('is not an email address').transform(normaliseEmail);

const phone = z.string().trim().min(5).max(40);

const KNOWN_CITIES = Object.values(CITY_SPELLINGS)
  .map((s) => s[0])
  .join(', ');

const minutesField = (min: number) =>
  z
    .int()
    .min(min)
    .max(24 * 60);

const court = z
  .strictObject({
    name: z.string().trim().min(1).max(80),
    sport: z.enum(SportType),
    /** COURT unless said otherwise; a football pitch may be FIELD. */
    resourceType: z.enum(ResourceType).default('COURT'),
    surface: z.enum(CourtSurface),
    indoor: z.boolean(),
    /** Players on the court, the bound for adding players to a booking (#358). */
    capacity: z.int().min(1).max(64),
    /**
     * Whole CENTS per hour. A decimal is somebody thinking in euros, and would
     * silently become €0.24/hour.
     */
    pricePerHourCents: z
      .int('must be whole CENTS per hour (2400 = €24.00), not euros')
      .min(1)
      .max(1_000_000),
    /** The start grid (Q16): bookings start every N minutes from opening. */
    slotStepMinutes: minutesField(5),
    /** The shortest booking, and the unit every booking is a whole number of. */
    minBookingMinutes: minutesField(15),
    maxBookingMinutes: minutesField(15),
    /** Overrides the venue's hours for this court only. */
    hours: weekHours.optional(),
  })
  .superRefine((c, ctx) => {
    // The same rules as the club's own court form (`courtCreateSchema`), plus
    // one it does not need: `quoteBooking` only sells whole multiples of the
    // minimum, so a maximum between two multiples could never be booked.
    if (c.maxBookingMinutes < c.minBookingMinutes) {
      ctx.addIssue({
        code: 'custom',
        path: ['maxBookingMinutes'],
        message: 'must not be below minBookingMinutes',
      });
    } else if (c.maxBookingMinutes % c.minBookingMinutes !== 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['maxBookingMinutes'],
        message: `must be a whole number of minBookingMinutes (${c.minBookingMinutes}): bookings are sold in ${c.minBookingMinutes}-minute units`,
      });
    }
    if (c.minBookingMinutes % c.slotStepMinutes !== 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['slotStepMinutes'],
        message: 'minBookingMinutes must be a whole number of slot steps',
      });
    }
    if ((c.pricePerHourCents * c.minBookingMinutes) % 60 !== 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['pricePerHourCents'],
        message: `${c.pricePerHourCents} cents/hour is not a whole number of cents per ${c.minBookingMinutes}-minute unit; the database prices units, and this will not round a club's price`,
      });
    }
  });

const venue = z
  .strictObject({
    /** Unique within the club; the public address `/venues/{publicSlug}` is derived from it. */
    slug,
    name: z.string().trim().min(1).max(120),
    address: z.string().trim().min(1).max(200),
    city: z
      .string()
      .trim()
      .refine((c) => cityKey(c) !== null, {
        message: `is not a city the app can name in Bulgarian. One of: ${KNOWN_CITIES} (or the Cyrillic spelling)`,
      })
      .transform(canonicalCity),
    lat: z.number().min(-90).max(90),
    lng: z.number().min(-180).max(180),
    timezone: z
      .string()
      .default('Europe/Sofia')
      .refine(
        (tz) => {
          try {
            new Intl.DateTimeFormat('en', { timeZone: tz });
            return true;
          } catch {
            return false;
          }
        },
        { message: 'is not an IANA timezone (e.g. "Europe/Sofia")' },
      ),
    /** The club's email and phone unless the venue has its own. */
    email: email.optional(),
    phone: phone.optional(),
    /** The club's cutoff unless this venue differs. */
    cancellationCutoffHours: z.int().min(0).max(168).optional(),
    hours: weekHours,
    courts: z.array(court).min(1, 'a venue needs at least one court'),
  })
  .superRefine((v, ctx) => {
    // A swapped lat/lng is still two valid numbers — Sofia reversed is a field
    // in Iraq — and no range check catches it. The pilot is Bulgarian, so the
    // box is Bulgaria's.
    if (v.lat < 41.2 || v.lat > 44.25 || v.lng < 22.35 || v.lng > 28.65) {
      ctx.addIssue({
        code: 'custom',
        path: ['lat'],
        message: `${v.lat}, ${v.lng} is outside Bulgaria. Are lat and lng swapped? Sofia is lat 42.69, lng 23.32`,
      });
    }

    const seen = new Set<string>();
    v.courts.forEach((c, i) => {
      if (seen.has(c.name)) {
        ctx.addIssue({
          code: 'custom',
          path: ['courts', i, 'name'],
          message: `"${c.name}" appears twice at this venue; a court is found again by its name`,
        });
      }
      seen.add(c.name);

      // A window shorter than the minimum booking offers no slot at all, and
      // a court with no slots reads as a bug in the calendar.
      const hours = c.hours ?? v.hours;
      for (const day of DAY_KEYS) {
        for (const [open, close] of hours[day]) {
          if (close - open < c.minBookingMinutes) {
            ctx.addIssue({
              code: 'custom',
              path: ['courts', i, c.hours ? 'hours' : 'minBookingMinutes'],
              message: `${day} ${hhmm(open)}–${hhmm(close)} is shorter than the ${c.minBookingMinutes}-minute minimum booking, so nobody could book it`,
            });
          }
        }
      }
    });
  });

export const clubSpecSchema = z
  .strictObject({
    club: z.strictObject({
      /** `/clubs/{slug}`, and the club's admin at `/t/{slug}`. */
      slug,
      name: z.string().trim().min(1).max(120),
      email,
      phone: phone.optional(),
      owner: z.strictObject({ email, name: z.string().trim().min(1).max(120).optional() }),
      /** How many hours before the start a player may still cancel (#354). Every venue, unless it says otherwise. */
      cancellationCutoffHours: z.int().min(0).max(168),
      /** Upcoming online bookings one player may hold at this club (#380). */
      maxUpcomingOnlineBookings: z.int().min(1).max(50),
    }),
    venues: z.array(venue).min(1, 'a club needs at least one venue'),
  })
  .superRefine((s, ctx) => {
    const seen = new Set<string>();
    s.venues.forEach((v, i) => {
      if (seen.has(v.slug)) {
        ctx.addIssue({
          code: 'custom',
          path: ['venues', i, 'slug'],
          message: `"${v.slug}" appears twice; a venue is found again by its slug`,
        });
      }
      seen.add(v.slug);
    });
  });

export type ClubSpec = z.output<typeof clubSpecSchema>;
export type VenueSpec = ClubSpec['venues'][number];
export type CourtSpec = VenueSpec['courts'][number];

/** Validate a parsed JSON value. Errors are one line each, with the path that is wrong. */
export function parseClubSpec(
  input: unknown,
): { ok: true; spec: ClubSpec } | { ok: false; errors: string[] } {
  const result = clubSpecSchema.safeParse(input);
  if (result.success) return { ok: true, spec: result.data };
  return {
    ok: false,
    errors: result.error.issues.map((i) => {
      const path = i.path
        .map((p, n) => (typeof p === 'number' ? `[${p}]` : `${n ? '.' : ''}${String(p)}`))
        .join('');
      // An unknown key is usually a typo; say which.
      const message =
        i.code === 'unrecognized_keys' ? `unknown key(s): ${i.keys.join(', ')}` : i.message;
      return `${path || '(root)'}: ${message}`;
    }),
  };
}

// ═══ THE WALK ═══════════════════════════════════════════════════════

export interface Diff {
  field: string;
  from: string;
  to: string;
}

export interface PlanItem {
  op: 'create' | 'change';
  what: 'club' | 'owner' | 'venue' | 'court' | 'hours' | 'pricing';
  label: string;
  /** Extra lines for a create (a court's hours, its price). */
  details?: string[];
  diffs?: Diff[];
}

export interface VenueOutcome {
  name: string;
  slug: string;
  /** Null only in a dry run of a venue that does not exist yet: the database picks it. */
  publicSlug: string | null;
  lat: number;
  lng: number;
}

interface Walk {
  items: PlanItem[];
  tenantId: string | null;
  venues: VenueOutcome[];
}

interface WalkOptions {
  write: boolean;
  now: Date;
  operator: string | null;
  specPath: string | null;
}

/** The base rule every onboarded court gets; found again by this name. */
export const BASE_RULE_NAME = 'Базова цена';

const money = (cents: number) => `€${(cents / 100).toFixed(2)}`;
const show = (v: unknown) => (v === null || v === undefined || v === '' ? '—' : String(v));
const fixed7 = (n: number | Prisma.Decimal) => Number(n).toFixed(7);

function diff(pairs: Array<[field: string, from: unknown, to: unknown]>): Diff[] {
  return pairs
    .filter(([, from, to]) => to !== undefined && show(from) !== show(to))
    .map(([field, from, to]) => ({ field, from: show(from), to: show(to) }));
}

const dayLine = (windows: readonly Window[]) =>
  windows.length === 0 ? 'closed' : windows.map(([o, c]) => `${hhmm(o)}–${hhmm(c)}`).join(', ');

/** `mon 07:00–23:00` … in the order a club reads a week. */
function weekLines(hours: WeekHours): string[] {
  return [...DAY_KEYS.slice(1), DAY_KEYS[0]].map((d) => `${d} ${dayLine(hours[d])}`);
}

function hoursFromRows(rows: Array<{ dayOfWeek: number; openTime: Date; closeTime: Date }>) {
  const week = Object.fromEntries(DAY_KEYS.map((d) => [d, [] as Window[]])) as WeekHours;
  for (const r of rows) {
    const day = DAY_KEYS[r.dayOfWeek];
    if (!day) continue;
    week[day].push([minutes(clockOf(r.openTime)), minutes(clockOf(r.closeTime))]);
  }
  for (const d of DAY_KEYS) week[d].sort((a, b) => a[0] - b[0]);
  return week;
}

function availabilityRows(
  tenantId: string,
  resourceId: string,
  hours: WeekHours,
  effectiveFrom: Date | null,
): Prisma.ResourceAvailabilityCreateManyInput[] {
  return DAY_KEYS.flatMap((day, dayOfWeek) =>
    hours[day].map(([open, close]) => ({
      tenantId,
      resourceId,
      dayOfWeek,
      openTime: timeOfDay(hhmm(open)),
      closeTime: timeOfDay(hhmm(close)),
      effectiveFrom,
    })),
  );
}

/**
 * Local midnight today at the venue, as the instant the availability engine
 * compares `effectiveFrom`/`effectiveTo` with — built the way `computeSlots`
 * builds its `dayStartUtc`, so the old hours stop and the new start on the
 * same day, today, with no day where both or neither apply.
 */
function startOfLocalDay(now: Date, timezone: string): Date {
  const local = toZonedTime(now, timezone);
  return fromZonedTime(
    new Date(local.getFullYear(), local.getMonth(), local.getDate(), 0, 0, 0, 0),
    timezone,
  );
}

function courtDetails(c: CourtSpec, hours: WeekHours, ownHours: boolean): string[] {
  const unit = (c.pricePerHourCents * c.minBookingMinutes) / 60;
  return [
    `${c.sport} ${c.resourceType}, ${c.surface}, ${c.indoor ? 'indoor' : 'outdoor'}, up to ${c.capacity} players`,
    `starts every ${c.slotStepMinutes} min; bookings ${c.minBookingMinutes}–${c.maxBookingMinutes} min in ${c.minBookingMinutes}-min units`,
    `${money(c.pricePerHourCents)}/hour = ${money(unit)} per ${c.minBookingMinutes}-min unit (basePriceCents ${unit}); base pricing rule "${BASE_RULE_NAME}" ×1.00`,
    `hours${ownHours ? ' (this court only)' : ''}: ${weekLines(hours).join('; ')}`,
  ];
}

async function walk(db: PrismaClient, spec: ClubSpec, opts: WalkOptions): Promise<Walk> {
  const { write } = opts;
  const items: PlanItem[] = [];
  const venues: VenueOutcome[] = [];
  const audits: Array<Omit<AuditInput, 'tenantId'>> = [];
  const c = spec.club;

  const audit = (
    op: 'create' | 'change',
    entity: string,
    entityId: string,
    details: string,
    json: Record<string, unknown> = {},
  ) =>
    audits.push({
      actorType: 'SYSTEM',
      actorUserId: null,
      entity,
      entityId,
      action:
        op === 'create'
          ? AUDIT_ACTIONS.CLUB_ONBOARDING_CREATED
          : AUDIT_ACTIONS.CLUB_ONBOARDING_UPDATED,
      details,
      detailsJson: {
        source: 'scripts/onboard-club.ts',
        operator: opts.operator,
        spec: opts.specPath,
        ...json,
      } as Prisma.InputJsonValue,
    });

  // ── The club ─────────────────────────────────────────────────────
  const org = await db.venueOrg.findUnique({
    where: { slug: c.slug },
    select: {
      id: true,
      name: true,
      contactEmail: true,
      contactPhone: true,
      maxUpcomingOnlineBookings: true,
    },
  });
  let tenantId = org?.id ?? null;
  const firstVenue = spec.venues[0]!;

  if (!org) {
    const label = `club ${c.name} (/clubs/${c.slug})`;
    items.push({
      op: 'create',
      what: 'club',
      label,
      details: [
        `contact ${c.email}${c.phone ? `, ${c.phone}` : ''}`,
        `cancellation cutoff ${c.cancellationCutoffHours}h; at most ${c.maxUpcomingOnlineBookings} upcoming online bookings per player`,
      ],
    });
    if (write) {
      const created = await db.venueOrg.create({
        data: {
          slug: c.slug,
          name: c.name,
          contactEmail: c.email,
          contactPhone: c.phone ?? null,
          addressLine: firstVenue.address,
          city: firstVenue.city,
          maxUpcomingOnlineBookings: c.maxUpcomingOnlineBookings,
        },
        select: { id: true },
      });
      tenantId = created.id;
      audit('create', 'VenueOrg', created.id, label);
    }
  } else {
    const diffs = diff([
      ['name', org.name, c.name],
      ['email', org.contactEmail, c.email],
      ['phone', org.contactPhone, c.phone],
      ['maxUpcomingOnlineBookings', org.maxUpcomingOnlineBookings, c.maxUpcomingOnlineBookings],
    ]);
    if (diffs.length > 0) {
      const label = `club ${org.name} (${c.slug})`;
      items.push({ op: 'change', what: 'club', label, diffs });
      if (write) {
        await db.venueOrg.update({
          where: { id: org.id },
          data: {
            name: c.name,
            contactEmail: c.email,
            ...(c.phone !== undefined ? { contactPhone: c.phone } : {}),
            maxUpcomingOnlineBookings: c.maxUpcomingOnlineBookings,
          },
        });
        audit('change', 'VenueOrg', org.id, label, { diffs });
      }
    }
  }

  // ── The owner (#263) ─────────────────────────────────────────────
  //
  // Decided BEFORE any venue is touched. A refusal throws: in the plan that
  // is the whole answer, and in the apply it rolls the transaction back.
  const decision = await decideOwner(db, c.owner.email, tenantId);
  const membership =
    tenantId && decision.userId
      ? await db.tenantMembership.findUnique({
          where: { userId_tenantId: { userId: decision.userId, tenantId } },
          select: { role: true, status: true },
        })
      : null;

  if (!(membership?.role === 'OWNER' && membership.status === 'ACTIVE')) {
    const account = !decision.userId
      ? 'a new account, linked when they first sign in with Google or Facebook as this address'
      : decision.becomes
        ? 'an existing account that holds nothing yet; it becomes a CLUB account'
        : 'an existing club account of this club';
    const label = `owner ${decision.email}: ${account}`;

    if (!org) {
      items.push({ op: 'create', what: 'owner', label });
    } else {
      const owners = await db.tenantMembership.findMany({
        where: { tenantId: org.id, role: 'OWNER', status: 'ACTIVE' },
        select: { user: { select: { email: true } } },
        orderBy: { createdAt: 'asc' },
        take: 20,
      });
      const current = owners.map((o) => o.user.email).join(', ');
      items.push({
        op: 'change',
        what: 'owner',
        label: `${label}. Added beside the current owner(s), who stay`,
        diffs: [
          {
            field: 'owners',
            from: show(current),
            to: [current, decision.email].filter(Boolean).join(', '),
          },
        ],
      });
    }
    if (write) {
      const { userId } = await assignOwner(db, decision, tenantId!, c.owner.name ?? null);
      audit(org ? 'change' : 'create', 'TenantMembership', userId, label, {
        owner: decision.email,
        role: 'OWNER',
      });
    }
  }

  // ── Venues and their courts ──────────────────────────────────────
  for (const v of spec.venues) {
    const cutoff = v.cancellationCutoffHours ?? c.cancellationCutoffHours;
    const existingVenue = tenantId
      ? await db.venue.findUnique({
          where: { tenantId_slug: { tenantId, slug: v.slug } },
          select: {
            id: true,
            publicSlug: true,
            name: true,
            addressLine: true,
            city: true,
            lat: true,
            lng: true,
            timezone: true,
            email: true,
            phone: true,
            cancellationCutoffHours: true,
          },
        })
      : null;

    let venueId = existingVenue?.id ?? null;
    let publicSlug = existingVenue?.publicSlug ?? null;

    if (!existingVenue) {
      const label = `venue ${v.name} (${v.slug}), ${v.address}, ${v.city}`;
      items.push({
        op: 'create',
        what: 'venue',
        label,
        details: [
          `${v.lat}, ${v.lng} — https://www.openstreetmap.org/?mlat=${v.lat}&mlon=${v.lng}#map=17/${v.lat}/${v.lng}`,
          `timezone ${v.timezone}; cancellation cutoff ${cutoff}h`,
          `hours: ${weekLines(v.hours).join('; ')}`,
        ],
      });
      if (write) {
        const created = await db.venue.create({
          data: {
            tenantId: tenantId!,
            slug: v.slug,
            name: v.name,
            addressLine: v.address,
            city: v.city,
            lat: v.lat,
            lng: v.lng,
            timezone: v.timezone,
            email: v.email ?? c.email,
            phone: v.phone ?? c.phone ?? null,
            cancellationCutoffHours: cutoff,
            // `publicSlug` is left to the P41 trigger, which makes it unique
            // across every club.
          },
          select: { id: true, publicSlug: true },
        });
        venueId = created.id;
        publicSlug = created.publicSlug;
        audit('create', 'Venue', created.id, label);
      }
    } else {
      const diffs = diff([
        ['name', existingVenue.name, v.name],
        ['address', existingVenue.addressLine, v.address],
        ['city', existingVenue.city, v.city],
        ['lat', fixed7(existingVenue.lat), fixed7(v.lat)],
        ['lng', fixed7(existingVenue.lng), fixed7(v.lng)],
        ['timezone', existingVenue.timezone, v.timezone],
        ['email', existingVenue.email, v.email],
        ['phone', existingVenue.phone, v.phone],
        ['cancellationCutoffHours', existingVenue.cancellationCutoffHours, cutoff],
      ]);
      if (diffs.length > 0) {
        const label = `venue ${existingVenue.name} (${v.slug})`;
        items.push({ op: 'change', what: 'venue', label, diffs });
        if (write) {
          await db.venue.update({
            where: { id: existingVenue.id },
            data: {
              name: v.name,
              addressLine: v.address,
              city: v.city,
              lat: v.lat,
              lng: v.lng,
              timezone: v.timezone,
              ...(v.email !== undefined ? { email: v.email } : {}),
              ...(v.phone !== undefined ? { phone: v.phone } : {}),
              cancellationCutoffHours: cutoff,
            },
          });
          audit('change', 'Venue', existingVenue.id, label, { diffs });
        }
      }
    }

    venues.push({ name: v.name, slug: v.slug, publicSlug, lat: v.lat, lng: v.lng });

    for (const ct of v.courts) {
      await walkCourt(db, {
        tenantId,
        venueId,
        venueSlug: v.slug,
        timezone: v.timezone,
        court: ct,
        hours: ct.hours ?? v.hours,
        items,
        audit,
        opts,
      });
    }
  }

  if (write && audits.length > 0) {
    await appendAuditEntries(
      db,
      audits.map((a) => ({ ...a, tenantId: tenantId! })),
    );
  }

  return { items, tenantId, venues };
}

async function walkCourt(
  db: PrismaClient,
  ctx: {
    tenantId: string | null;
    venueId: string | null;
    venueSlug: string;
    timezone: string;
    court: CourtSpec;
    hours: WeekHours;
    items: PlanItem[];
    audit: (
      op: 'create' | 'change',
      entity: string,
      entityId: string,
      details: string,
      json?: Record<string, unknown>,
    ) => void;
    opts: WalkOptions;
  },
): Promise<void> {
  const { court: c, hours, items, audit, opts } = ctx;
  const { write } = opts;
  const unitPrice = (c.pricePerHourCents * c.minBookingMinutes) / 60;
  const where = `${ctx.venueSlug} / ${c.name}`;

  const existing =
    ctx.tenantId && ctx.venueId
      ? await db.resource.findFirst({
          where: { tenantId: ctx.tenantId, venueId: ctx.venueId, name: c.name },
          orderBy: { createdAt: 'asc' },
          select: {
            id: true,
            sport: true,
            resourceType: true,
            surface: true,
            isIndoor: true,
            capacity: true,
            basePriceCents: true,
            slotStepMinutes: true,
            minBookingMinutes: true,
            maxBookingMinutes: true,
            // The CURRENT weekly hours: recurring rows not yet retired. One-off
            // exceptions (holidays) are the club's, and are left alone.
            availability: {
              where: { exceptionDate: null, effectiveTo: null },
              select: { id: true, dayOfWeek: true, openTime: true, closeTime: true },
            },
            pricingRules: { where: { name: BASE_RULE_NAME }, select: { id: true }, take: 1 },
          },
        })
      : null;

  const createBaseRule = async (resourceId: string) => {
    // ═══ THE BASE RULE IS ×1.00, NOT A FIXED PRICE ═══
    //
    // The price itself is `basePriceCents`, which the club can change on its
    // courts screen. A fixed-price catch-all would override that edit without
    // a word — the club types a new price and nothing changes. A ×1.00 rule
    // prices exactly `basePriceCents`, shows the club where its pricing
    // starts, and loses to any rule it adds (priority 0, the lowest).
    //
    // `conditionsJson`, the column the engine reads (#350): empty, so it
    // matches every day and time.
    const rule = await db.pricingRule.create({
      data: {
        tenantId: ctx.tenantId!,
        resourceId,
        name: BASE_RULE_NAME,
        priority: 0,
        conditionsJson: {},
        multiplier: 1,
        fixedPriceCents: null,
      },
      select: { id: true },
    });
    return rule.id;
  };

  if (!existing) {
    const label = `court ${where}`;
    items.push({
      op: 'create',
      what: 'court',
      label,
      details: courtDetails(c, hours, c.hours !== undefined),
    });
    if (write) {
      const created = await db.resource.create({
        data: {
          tenantId: ctx.tenantId!,
          venueId: ctx.venueId!,
          name: c.name,
          sport: c.sport,
          resourceType: c.resourceType,
          surface: c.surface,
          isIndoor: c.indoor,
          capacity: c.capacity,
          basePriceCents: unitPrice,
          slotStepMinutes: c.slotStepMinutes,
          minBookingMinutes: c.minBookingMinutes,
          maxBookingMinutes: c.maxBookingMinutes,
        },
        select: { id: true },
      });
      // Without availability rows the court is open zero hours a week — a
      // court nobody can book, which looks exactly like a bug in booking.
      await db.resourceAvailability.createMany({
        data: availabilityRows(ctx.tenantId!, created.id, hours, null),
      });
      await createBaseRule(created.id);
      audit('create', 'Resource', created.id, label, {
        pricePerHourCents: c.pricePerHourCents,
        basePriceCents: unitPrice,
        hours: weekLines(hours),
      });
    }
    return;
  }

  // ── An existing court: report what differs ───────────────────────
  const diffs = diff([
    ['sport', existing.sport, c.sport],
    ['resourceType', existing.resourceType, c.resourceType],
    ['surface', existing.surface, c.surface],
    ['indoor', existing.isIndoor, c.indoor],
    ['capacity', existing.capacity, c.capacity],
    ['slotStepMinutes', existing.slotStepMinutes, c.slotStepMinutes],
    ['minBookingMinutes', existing.minBookingMinutes, c.minBookingMinutes],
    ['maxBookingMinutes', existing.maxBookingMinutes, c.maxBookingMinutes],
  ]);
  if (existing.basePriceCents !== unitPrice) {
    const perHour = (existing.basePriceCents * 60) / existing.minBookingMinutes;
    diffs.push({
      field: 'price',
      from: `${money(perHour)}/hour (basePriceCents ${existing.basePriceCents} per ${existing.minBookingMinutes} min)`,
      to: `${money(c.pricePerHourCents)}/hour (basePriceCents ${unitPrice} per ${c.minBookingMinutes} min)`,
    });
  }
  if (diffs.length > 0) {
    const label = `court ${where}`;
    items.push({ op: 'change', what: 'court', label, diffs });
    if (write) {
      await db.resource.update({
        where: { id: existing.id },
        data: {
          sport: c.sport,
          resourceType: c.resourceType,
          surface: c.surface,
          isIndoor: c.indoor,
          capacity: c.capacity,
          basePriceCents: unitPrice,
          slotStepMinutes: c.slotStepMinutes,
          minBookingMinutes: c.minBookingMinutes,
          maxBookingMinutes: c.maxBookingMinutes,
        },
      });
      audit('change', 'Resource', existing.id, label, { diffs });
    }
  }

  const current = hoursFromRows(existing.availability);
  const hourDiffs = DAY_KEYS.filter((d) => dayLine(current[d]) !== dayLine(hours[d])).map((d) => ({
    field: d,
    from: dayLine(current[d]),
    to: dayLine(hours[d]),
  }));
  if (hourDiffs.length > 0) {
    const label = `hours of court ${where} (from today; the old hours are kept as history)`;
    items.push({ op: 'change', what: 'hours', label, diffs: hourDiffs });
    if (write) {
      // Retired, not deleted: the old rows stop applying from today's local
      // midnight and the new ones start at it. See `startOfLocalDay`.
      const from = startOfLocalDay(opts.now, ctx.timezone);
      await db.resourceAvailability.updateMany({
        where: { id: { in: existing.availability.map((a) => a.id) } },
        data: { effectiveTo: new Date(from.getTime() - 1) },
      });
      await db.resourceAvailability.createMany({
        data: availabilityRows(ctx.tenantId!, existing.id, hours, from),
      });
      audit('change', 'ResourceAvailability', existing.id, label, { diffs: hourDiffs });
    }
  }

  if (existing.pricingRules.length === 0) {
    const label = `base pricing rule "${BASE_RULE_NAME}" ×1.00 on court ${where}`;
    items.push({ op: 'create', what: 'pricing', label });
    if (write) {
      const ruleId = await createBaseRule(existing.id);
      audit('create', 'PricingRule', ruleId, label);
    }
  }
}

// ═══ THE ENTRY POINT ════════════════════════════════════════════════

export type OnboardResult =
  | { outcome: 'refused'; reason: string }
  /** Something exists with other values, and `--update` was not given. Nothing written. */
  | { outcome: 'needs-update'; items: PlanItem[] }
  | { outcome: 'dry-run'; items: PlanItem[]; needsUpdate: boolean; venues: VenueOutcome[] }
  | { outcome: 'no-op'; tenantId: string; venues: VenueOutcome[] }
  | { outcome: 'applied'; items: PlanItem[]; tenantId: string; venues: VenueOutcome[] };

export interface OnboardOptions {
  dryRun?: boolean;
  /** Apply differences to what exists. Without it they are reported and nothing is written. */
  update?: boolean;
  /** Who ran it, for the audit rows. */
  operator?: string | null;
  /** The spec's path, for the audit rows. */
  specPath?: string | null;
  /** Injected by tests; the instant changed hours take effect from (its local day). */
  now?: Date;
}

/**
 * Plan, then — unless it is a dry run, a refusal, or a change without
 * `update` — apply in ONE transaction. `db` must be the owner connection.
 */
export async function onboardClub(
  db: PrismaClient,
  spec: ClubSpec,
  options: OnboardOptions = {},
): Promise<OnboardResult> {
  const opts: WalkOptions = {
    write: false,
    now: options.now ?? new Date(),
    operator: options.operator ?? null,
    specPath: options.specPath ?? null,
  };

  let plan: Walk;
  try {
    plan = await walk(db, spec, opts);
  } catch (err) {
    if (err instanceof OwnerRefusedError) return { outcome: 'refused', reason: err.message };
    throw err;
  }

  const changes = plan.items.some((i) => i.op === 'change');
  if (options.dryRun) {
    return {
      outcome: 'dry-run',
      items: plan.items,
      needsUpdate: changes && !options.update,
      venues: plan.venues,
    };
  }
  if (changes && !options.update) return { outcome: 'needs-update', items: plan.items };
  if (plan.items.length === 0) {
    return { outcome: 'no-op', tenantId: plan.tenantId!, venues: plan.venues };
  }

  try {
    const applied = await db.$transaction(
      (tx) => walk(tx as unknown as PrismaClient, spec, { ...opts, write: true }),
      // A club with a dozen courts is a few hundred statements; Prisma's 5s
      // default would roll the whole club back half way through.
      { timeout: 120_000, maxWait: 10_000 },
    );
    return {
      outcome: 'applied',
      items: applied.items,
      tenantId: applied.tenantId!,
      venues: applied.venues,
    };
  } catch (err) {
    if (err instanceof OwnerRefusedError) return { outcome: 'refused', reason: err.message };
    throw err;
  }
}

/** The plan as an operator reads it: `+` creates, `~` changes. */
export function formatItems(items: readonly PlanItem[]): string {
  if (items.length === 0) return '  (nothing: everything in the spec already exists as written)';
  return items
    .map((i) => {
      const lines = [`  ${i.op === 'create' ? '+' : '~'} ${i.label}`];
      for (const d of i.details ?? []) lines.push(`      ${d}`);
      for (const d of i.diffs ?? []) lines.push(`      ${d.field}: ${d.from}  →  ${d.to}`);
      return lines.join('\n');
    })
    .join('\n');
}
