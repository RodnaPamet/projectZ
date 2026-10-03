import type { Prisma } from '@prisma/client';

import { playerCancellableUntil } from '@/lib/booking/cutoff';

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
  /**
   * The slug of the CLUB that owns the venue — what every `/t/{slug}/**` route
   * takes, and NOT the venue's own `slug` above.
   *
   * The two look alike and are not interchangeable: a venue slug is unique
   * only within its club (`@@unique([tenantId, slug])`), a club slug is unique
   * everywhere. Until this field existed no public DTO carried a club slug at
   * all, so the iOS client sent the VENUE slug to `POST /t/{slug}/bookings`
   * (VenueDetailModel.swift) — which works only while a club happens to name
   * its venue after itself, and fails as "not a member" the day it does not.
   */
  clubSlug: string;
  name: string;
  city: string;
  country: string;
  avgRating: number;
  reviewCount: number;
  sports: string[];
  fromPriceCents: number | null;
  coverPhotoUrl: string | null;
}

/**
 * `clubSlug` is an argument rather than read off `v` because `Venue` has no
 * relation to `VenueOrg` in the schema — only a `tenantId` column — so the
 * caller looks the slugs up once per page (see the v1 venue routes).
 */
export function toVenueSummary(v: VenueWithResources, clubSlug: string): VenueSummary {
  const active = v.resources.filter((r) => r.status === 'ACTIVE');

  return {
    id: v.id,
    slug: v.slug,
    clubSlug,
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

export function toVenueDetail(v: VenueFull, clubSlug: string): VenueDetail {
  const active = v.resources.filter((r) => r.status === 'ACTIVE');

  return {
    ...toVenueSummary(v, clubSlug),

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
 * `clubSlug` is NOT that: it is the public address of a club, already in every
 * `/t/{slug}` URL, and a client cannot book without it.
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

export interface BookingDto {
  id: string;
  status: string;
  startTs: string;
  endTs: string;
  totalCents: number;
  currency: string;
  /** When a PENDING booking stops holding its slot. Null once confirmed. */
  expiresAt: string | null;
  cancelledAt: string | null;
  createdAt: string;
  /**
   * The last instant the PLAYER may cancel this booking in the app (#354): the
   * venue's cutoff before the start. Null when it is not cancellable at all
   * (cancelled, completed, no-show). May be in the past — then only the club
   * can cancel, and POST …/cancel answers 403 CANCELLATION_CUTOFF_PASSED.
   */
  cancellableUntil: string | null;
  resource: {
    id: string;
    name: string;
    sport: string;
  };
  venue: {
    id: string;
    name: string;
    timezone: string;
  };
}

type BookingRow = {
  id: string;
  startTs: Date;
  endTs: Date;
  status: string;
  totalCents: number;
  currency: string;
  expiresAt: Date | null;
  cancelledAt: Date | null;
  createdAt: Date;
  resource: {
    id: string;
    name: string;
    sport: string;
    venue: { id: string; name: string; timezone: string; cancellationCutoffHours: number };
  };
};

/**
 * The venue is lifted OUT of the resource rather than left nested.
 *
 * A client rendering "Court 1 — Slot Club" should not have to know that the
 * venue happens to hang off the resource in our schema. Flattening it here
 * means the wire shape survives a schema change that moves the relation, and
 * a Swift struct does not acquire a pointless intermediate type.
 */
export function toBooking(b: BookingRow): BookingDto {
  return {
    id: b.id,
    status: b.status,
    startTs: rfc3339(b.startTs),
    endTs: rfc3339(b.endTs),
    totalCents: b.totalCents,
    currency: b.currency,
    expiresAt: b.expiresAt ? rfc3339(b.expiresAt) : null,
    cancelledAt: b.cancelledAt ? rfc3339(b.cancelledAt) : null,
    createdAt: rfc3339(b.createdAt),
    cancellableUntil:
      b.status === 'PENDING' || b.status === 'CONFIRMED'
        ? rfc3339(playerCancellableUntil(b.startTs, b.resource.venue.cancellationCutoffHours))
        : null,
    resource: { id: b.resource.id, name: b.resource.name, sport: b.resource.sport },
    // Rebuilt, not passed through: the cutoff is on the row for the line
    // above, and a venue block that grew a field with every select would be a
    // wire shape nobody decided.
    venue: {
      id: b.resource.venue.id,
      name: b.resource.venue.name,
      timezone: b.resource.venue.timezone,
    },
  };
}

/**
 * One of the caller's own bookings, at any club: `GET /api/v1/me/bookings`.
 *
 * `BookingDto` plus what a cross-club list needs and a per-club one does not:
 * which club each row belongs to, and where the caller stands on reviewing
 * the venue. The resource and venue blocks are `BookingDto`'s, unchanged.
 *
 * ═══ ONE MAPPER, FOR THE ROUTE AND FOR THE PAGE'S SERVER SEED ═══
 *
 * The web `/me` page will render its first paint from the server and then
 * revalidate through this endpoint (the client data layer). If the seed and
 * the endpoint were shaped by two functions, the first revalidation would
 * swap one shape for another under the person's thumb. So both call this.
 */
export interface MyBookingDto extends BookingDto {
  /**
   * The club's slug — what `POST /t/{slug}/bookings/{id}/cancel` and `/review`
   * take. Null only if the club row is gone (`booking.tenantId` is not a
   * foreign key); such a booking can be shown and not acted on.
   */
  clubSlug: string | null;
  /**
   * The caller's review of this booking's VENUE, if they wrote one — at most
   * one per venue, so it may have been left against a different booking
   * there (`venueReview.bookingId !== id`).
   */
  venueReview: {
    id: string;
    bookingId: string | null;
    rating: number;
    /** Open string, as `ReviewDto.status`. */
    status: string;
  } | null;
  /**
   * Whether a review can be submitted from this booking now: it is COMPLETED
   * and the venue has no review from the caller yet. Decided by the server
   * (`canReview` in `usecases/my-bookings`) so no client restates the rule.
   */
  canReview: boolean;
}

export function toMyBookingDto(
  b: BookingRow & {
    clubSlug: string | null;
    venueReview: { id: string; bookingId: string | null; rating: number; status: string } | null;
    canReview: boolean;
  },
): MyBookingDto {
  return {
    ...toBooking(b),
    clubSlug: b.clubSlug,
    // Rebuilt field by field rather than passed through, for the reason at the
    // top of this file: a spread publishes whatever the use case adds next.
    venueReview: b.venueReview
      ? {
          id: b.venueReview.id,
          bookingId: b.venueReview.bookingId,
          rating: b.venueReview.rating,
          status: b.venueReview.status,
        }
      : null,
    canReview: b.canReview,
  };
}

export interface ReviewDto {
  id: string;
  bookingId: string;
  venueId: string;
  rating: number;
  /** The text as stored — sanitised on the way in. Null for a star-only review. */
  body: string | null;
  /**
   * `PUBLISHED`, `PENDING_REVIEW` or `REJECTED`, as an OPEN string for the
   * same reason as `BookingDto.status`: a shipped binary must not fail to
   * decode a value added later.
   */
  status: string;
  createdAt: string;
}

/**
 * The author's own view of what they just submitted.
 *
 * No author id and no moderation scores. The author knows who they are, and
 * the classifier's numbers are for the moderator judging the machine — handed
 * to the author they are a gauge for tuning text until it slips under the
 * threshold.
 */
export function toReview(r: {
  id: string;
  bookingId: string;
  venueId: string;
  rating: number;
  body: string | null;
  status: string;
  createdAt: Date;
}): ReviewDto {
  return {
    id: r.id,
    bookingId: r.bookingId,
    venueId: r.venueId,
    rating: r.rating,
    body: r.body,
    status: r.status,
    createdAt: rfc3339(r.createdAt),
  };
}

export interface ModerationCaseItemDto {
  caseId: string;
  reason: string;
  openedAt: string;
  scores: Record<string, number>;
  review: { id: string; rating: number; body: string | null; status: string; createdAt: string };
  venue: { id: string; name: string };
  club: { id: string; slug: string; name: string };
}

/**
 * One case in the platform moderation queue.
 *
 * No author, deliberately — see `listReviewCases`. Whether a review is abuse
 * does not depend on who wrote it.
 */
export function toModerationCaseItem(c: {
  caseId: string;
  reason: string;
  openedAt: Date;
  scores: Record<string, number>;
  review: { id: string; rating: number; body: string | null; status: string; createdAt: Date };
  venue: { id: string; name: string };
  club: { id: string; slug: string; name: string };
}): ModerationCaseItemDto {
  return {
    caseId: c.caseId,
    reason: c.reason,
    openedAt: rfc3339(c.openedAt),
    scores: c.scores,
    review: {
      id: c.review.id,
      rating: c.review.rating,
      body: c.review.body,
      status: c.review.status,
      createdAt: rfc3339(c.review.createdAt),
    },
    venue: c.venue,
    club: c.club,
  };
}

export interface ModerationResolutionDto {
  caseId: string;
  status: string;
  review: { id: string; status: string } | null;
  venue: { id: string; avgRating: number; reviewCount: number } | null;
}

export function toModerationResolution(r: {
  caseId: string;
  status: string;
  review: { id: string; status: string } | null;
  venue: { id: string; avgRating: number; reviewCount: number } | null;
}): ModerationResolutionDto {
  return { caseId: r.caseId, status: r.status, review: r.review, venue: r.venue };
}
