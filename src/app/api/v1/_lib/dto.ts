import type { Prisma } from '@prisma/client';

/**
 * Wire shapes for v1.
 *
 * ═══ WHY THESE ARE HAND-WRITTEN AND NOT `select: *` ═══
 *
 * A DTO built by spreading a Prisma row leaks whatever the schema grows next.
 * `Venue` already carries an internal `email`, a `cancellationPolicyJson` and a
 * `tenantId` that a public client has no business seeing — and the moment
 * somebody adds a column, a spread publishes it without anybody deciding to.
 *
 * ═══ DECIMAL IS A STRING ON THE WIRE ═══
 *
 * Measured, not assumed. `JSON.stringify` of a Prisma row gives:
 *
 *     {"lat":"42.6977123","lng":"23.3219456","avgRating":"0"}
 *
 * Prisma returns Decimal columns as Decimal objects that serialise to STRINGS.
 * A Swift client decoding `Double` fails on that — and it fails at the decoder,
 * so the error names the whole response rather than the field.
 *
 * Every Decimal is therefore coerced with `Number()` at this boundary. Callers
 * must not skip it "because it looked fine in the browser": JavaScript is
 * perfectly happy comparing a numeric string, which is exactly why this
 * survives until a typed client tries to read it.
 */

type VenueWithResources = Prisma.VenueGetPayload<{ include: { resources: true } }>;

export interface VenueSummary {
  id: string;
  slug: string;
  name: string;
  city: string;
  country: string;
  avgRating: number;
  reviewCount: number;
  sports: string[];
  fromPriceCents: number | null;
  coverPhotoUrl: string | null;
}

export function toVenueSummary(v: VenueWithResources): VenueSummary {
  const active = v.resources.filter((r) => r.status === 'ACTIVE');

  return {
    id: v.id,
    slug: v.slug,
    name: v.name,
    city: v.city,
    country: v.country,
    avgRating: Number(v.avgRating),
    reviewCount: v.reviewCount,
    sports: [...new Set(active.map((r) => r.sport))],
    // Null, not 0. A venue with no bookable court has no price, and 0 would
    // render as "free" on a card.
    fromPriceCents: active.length ? Math.min(...active.map((r) => r.basePriceCents)) : null,
    coverPhotoUrl: v.coverPhotoUrl,
  };
}

export interface VenueDetail extends VenueSummary {
  description: string | null;
  addressLine: string;
  lat: number;
  lng: number;
  timezone: string;
  phone: string | null;
  openingHours: unknown;
  resources: Array<{
    id: string;
    name: string;
    sport: string;
    surface: string | null;
    isIndoor: boolean;
    basePriceCents: number;
  }>;
}

type VenueFull = Prisma.VenueGetPayload<{
  include: { resources: true; photos: true; amenities: true };
}>;

export function toVenueDetail(v: VenueFull): VenueDetail {
  const active = v.resources.filter((r) => r.status === 'ACTIVE');

  return {
    ...toVenueSummary(v),

    // `description` is documented in the schema as "Encrypted at rest +
    // HTML-sanitised on write". It is NEITHER today: encryptField/decryptField
    // are used only by wearables.ts, and nothing touches this column. It is
    // plaintext, so it is returned as-is.
    //
    // If that comment is ever made true, this field starts returning ciphertext
    // to every client and the only symptom is gibberish on a venue page.
    // Whoever implements it must decrypt HERE.
    description: v.description,

    addressLine: v.addressLine,
    // Decimal(10,7) — string on the wire without this.
    lat: Number(v.lat),
    lng: Number(v.lng),
    timezone: v.timezone,
    phone: v.phone,
    openingHours: v.openingHoursJson,

    resources: active.map((r) => ({
      id: r.id,
      name: r.name,
      sport: r.sport,
      surface: r.surface,
      isIndoor: r.isIndoor,
      basePriceCents: r.basePriceCents,
    })),
  };
}

/**
 * Deliberately absent from both shapes: `email`, `phone` on the summary,
 * `tenantId`, `cancellationPolicyJson`, `amenityIds`, `geog`, `createdAt`,
 * `updatedAt`. `email` is the club's internal contact, not a public field;
 * `tenantId` would hand a client the tenancy model it is not supposed to know.
 */

/**
 * RFC 3339 with NO fractional seconds.
 *
 * ═══ WHY NOT toISOString() ═══
 *
 * `Date.toISOString()` always emits milliseconds — `2026-09-24T09:00:00.000Z`.
 * Swift's `JSONDecoder.DateDecodingStrategy.iso8601` wraps `ISO8601DateFormatter`
 * with its default option set, which does NOT include `.withFractionalSeconds`,
 * and it REJECTS a string that carries them.
 *
 * So the obvious, correct-looking spelling produces a payload the native client
 * cannot decode — and it fails at the decoder, so the thrown error names the
 * whole response rather than the offending field. On a shipped binary that is a
 * week of review to fix a trailing `.000`.
 *
 * Every timestamp crossing this boundary goes through here.
 */
export function rfc3339(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export interface SlotDto {
  startTs: string;
  endTs: string;
  priceCents: number;
  available: boolean;
  /** Present only when `available` is false. Currently always "booked". */
  blockedReason?: string;
}

export interface ResourceSlotsDto {
  resourceId: string;
  name: string;
  sport: string;
  currency: string;
  minBookingMinutes: number;
  slotStepMinutes: number;
  slots: SlotDto[];
}

export interface AvailabilityDto {
  venueId: string;
  venueName: string;
  /** IANA zone. The client needs it to render "09:00" rather than doing UTC maths. */
  timezone: string;
  from: string;
  to: string;
  resources: ResourceSlotsDto[];
}

/**
 * Unavailable slots are INCLUDED, deliberately.
 *
 * Returning only bookable slots would be a smaller payload and a worse app: a
 * grid that silently omits 18:00–19:00 reads as "the club is shut then", and
 * the player has no way to see that the court is simply taken. Showing it
 * greyed out is the difference between "closed" and "try another time".
 */
export function toAvailability(args: {
  venue: { id: string; name: string; timezone: string };
  from: Date;
  to: Date;
  resources: Array<{
    resource: {
      id: string;
      name: string;
      sport: string;
      currency: string;
      minBookingMinutes: number;
      slotStepMinutes: number;
    };
    slots: Array<{
      startTs: Date;
      endTs: Date;
      priceCents: number;
      available: boolean;
      blockedReason?: string;
    }>;
  }>;
}): AvailabilityDto {
  return {
    venueId: args.venue.id,
    venueName: args.venue.name,
    timezone: args.venue.timezone,
    from: rfc3339(args.from),
    to: rfc3339(args.to),
    resources: args.resources.map(({ resource, slots }) => ({
      resourceId: resource.id,
      name: resource.name,
      sport: resource.sport,
      currency: resource.currency,
      minBookingMinutes: resource.minBookingMinutes,
      slotStepMinutes: resource.slotStepMinutes,
      slots: slots.map((s) => ({
        startTs: rfc3339(s.startTs),
        endTs: rfc3339(s.endTs),
        // Already an integer count of cents from the pricing engine. Never a
        // Decimal, so no Number() coercion is needed or wanted here.
        priceCents: s.priceCents,
        available: s.available,
        ...(s.blockedReason ? { blockedReason: s.blockedReason } : {}),
      })),
    })),
  };
}

export interface GroupMappingDto {
  id: string;
  aadGroupId: string;
  aadGroupName: string | null;
  role: string;
  priority: number;
  createdAt: string;
  updatedAt: string;
}

export function toGroupMapping(m: {
  id: string;
  aadGroupId: string;
  aadGroupName: string | null;
  role: string;
  priority: number;
  createdAt: Date;
  updatedAt: Date;
}): GroupMappingDto {
  return {
    id: m.id,
    aadGroupId: m.aadGroupId,
    aadGroupName: m.aadGroupName,
    role: m.role,
    priority: m.priority,
    createdAt: rfc3339(m.createdAt),
    updatedAt: rfc3339(m.updatedAt),
  };
}
