import type { Prisma } from '@prisma/client';

import type { Me } from '@/app-layer/usecases/me';
import type { MyNotification, NotificationSettings } from '@/app-layer/usecases/my-notifications';

import { playerCancellableUntil } from '@/lib/booking/cutoff';
import { splitPhotos, type PhotoRow, type PhotoView } from '@/lib/media/photo-view';

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

/**
 * `photos` is optional: the list reads only the cover (`kind: 'COVER'`,
 * take 1), the detail reads them all, and a caller that read none gets
 * `cover: null` rather than a type error.
 */
type VenueWithResources = Prisma.VenueGetPayload<{ include: { resources: true } }> & {
  photos?: PhotoRow[];
};

/**
 * One uploaded venue photo (#366). Every URL is absolute and immutable (a
 * changed photo is a new URL), so a client may cache them for as long as it
 * likes. `variants` are WebP, ascending by width (640/1280/1920, never wider
 * than the upload); `url` is the 1280 one, or the widest below it. `width`
 * and `height` are the largest variant's, for the aspect ratio. `alt` is the
 * club's description, plain text, never empty for a photo uploaded since
 * #366. `blurDataUrl` is a ~16 px WebP `data:` URL to show while loading.
 */
export type VenuePhotoDto = PhotoView;

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
  /**
   * The venue's public address on the web, `/venues/{publicSlug}` (#355):
   * unique across every club, unlike `slug`. Null only for a venue written
   * before P41's trigger existed and missed by its backfill, which should be
   * none; such a venue is listed and not linked.
   */
  publicSlug: string | null;
  name: string;
  city: string;
  country: string;
  avgRating: number;
  reviewCount: number;
  sports: string[];
  fromPriceCents: number | null;
  /** The cover's default URL. Kept for clients that predate `cover`; prefer `cover`. */
  coverPhotoUrl: string | null;
  /** The venue's cover photo with every variant (#366), or null. */
  cover: VenuePhotoDto | null;
}

/**
 * `clubSlug` is an argument rather than read off `v` because `Venue` has no
 * relation to `VenueOrg` in the schema — only a `tenantId` column — so the
 * caller looks the slugs up once per page (see the v1 venue routes).
 */
export function toVenueSummary(v: VenueWithResources, clubSlug: string): VenueSummary {
  const active = v.resources.filter((r) => r.status === 'ACTIVE');
  const { cover } = splitPhotos(v.photos ?? []);

  return {
    id: v.id,
    slug: v.slug,
    clubSlug,
    publicSlug: v.publicSlug,
    name: v.name,
    city: v.city,
    country: v.country,
    avgRating: Number(v.avgRating),
    reviewCount: v.reviewCount,
    sports: [...new Set(active.map((r) => r.sport))],
    // Null, not 0. A venue with no bookable court has no price, and 0 would
    // render as "free" on a card.
    fromPriceCents: active.length ? Math.min(...active.map((r) => r.basePriceCents)) : null,
    coverPhotoUrl: cover?.url ?? v.coverPhotoUrl,
    cover,
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
  /** The gallery (#366), in the club's order; the cover is `cover`, not here. */
  photos: VenuePhotoDto[];
  resources: Array<{
    id: string;
    name: string;
    sport: string;
    /** `ResourceType` (P51); see `ResourceSlotsDto.resourceType`. */
    resourceType: string;
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
    photos: splitPhotos(v.photos).gallery,

    resources: active.map((r) => ({
      id: r.id,
      name: r.name,
      sport: r.sport,
      resourceType: r.resourceType,
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
  /**
   * Present only when `available` is true: every length this start can be
   * booked for (whole units of `minBookingMinutes`, up to
   * `maxBookingMinutes`, the whole span free and inside one opening window),
   * shortest first, each priced by the same quote `POST …/bookings` charges.
   * The first is always the slot itself. Empty when even that no longer fits.
   */
  durations?: SlotDurationDto[];
}

export interface SlotDurationDto {
  minutes: number;
  endTs: string;
  priceCents: number;
}

export interface ResourceSlotsDto {
  resourceId: string;
  name: string;
  sport: string;
  /**
   * `ResourceType` (P51): COURT, FIELD, TRACK… Booked and priced alike; a
   * TRACK (karting, hired whole) is called a "писта" rather than a "корт".
   */
  resourceType: string;
  currency: string;
  minBookingMinutes: number;
  /** The longest booking this resource takes, in minutes (Q16). */
  maxBookingMinutes: number;
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
      resourceType: string;
      currency: string;
      minBookingMinutes: number;
      maxBookingMinutes: number;
      slotStepMinutes: number;
    };
    slots: Array<{
      startTs: Date;
      endTs: Date;
      priceCents: number;
      available: boolean;
      blockedReason?: string;
      durations?: Array<{ minutes: number; endTs: Date; priceCents: number }>;
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
      resourceType: resource.resourceType,
      currency: resource.currency,
      minBookingMinutes: resource.minBookingMinutes,
      maxBookingMinutes: resource.maxBookingMinutes,
      slotStepMinutes: resource.slotStepMinutes,
      slots: slots.map((s) => ({
        startTs: rfc3339(s.startTs),
        endTs: rfc3339(s.endTs),
        // Already an integer count of cents from the pricing engine. Never a
        // Decimal, so no Number() coercion is needed or wanted here.
        priceCents: s.priceCents,
        available: s.available,
        ...(s.blockedReason ? { blockedReason: s.blockedReason } : {}),
        ...(s.durations
          ? {
              durations: s.durations.map((d) => ({
                minutes: d.minutes,
                endTs: rfc3339(d.endTs),
                priceCents: d.priceCents,
              })),
            }
          : {}),
      })),
    })),
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
    /** `ResourceType` (P51); see `ResourceSlotsDto.resourceType`. */
    resourceType: string;
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
    resourceType: string;
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
    resource: {
      id: b.resource.id,
      name: b.resource.name,
      sport: b.resource.sport,
      resourceType: b.resource.resourceType,
    },
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
  /**
   * The caller's side of it (#358): BOOKER made it; PARTICIPANT was added to
   * it by the booker or an invite link. A participant cannot cancel it (its
   * `cancellableUntil` is null) and may leave it instead.
   */
  viewerRole: 'BOOKER' | 'PARTICIPANT';
}

export function toMyBookingDto(
  b: BookingRow & {
    clubSlug: string | null;
    venueReview: { id: string; bookingId: string | null; rating: number; status: string } | null;
    canReview: boolean;
    viewerRole: 'BOOKER' | 'PARTICIPANT';
  },
): MyBookingDto {
  const base = toBooking(b);
  return {
    ...base,
    // Cancelling is the booker's (`POST /t/{slug}/bookings/{id}/cancel` finds
    // only their own); an added player is told there is nothing to cancel.
    cancellableUntil: b.viewerRole === 'BOOKER' ? base.cancellableUntil : null,
    viewerRole: b.viewerRole,
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

/**
 * One of the caller's own bookings in full: `GET /api/v1/me/bookings/{id}`
 * (#359), and the web's booking detail page through the same mapper.
 *
 * `MyBookingDto`, with the venue block widened to what "how do I get there"
 * needs, how it is paid, and who is playing. The list keeps the narrow venue
 * block: a page of twenty bookings has no use for twenty addresses.
 */
export interface MyBookingDetailDto extends Omit<MyBookingDto, 'venue'> {
  venue: BookingDto['venue'] & {
    /** `/venues/{publicSlug}` on the web; null for a venue that has none. */
    publicSlug: string | null;
    addressLine: string;
    city: string;
    lat: number;
    lng: number;
    phone: string | null;
  };
  /**
   * True when the price is paid at the club, not online (#354): every pilot
   * club. `totalCents` is then what the club will charge on the day.
   */
  payAtClub: boolean;
  /**
   * The people on the booking, the booker first, then added players by
   * position (#358). Display names and avatars only: no user ids and no
   * emails. `name` is null for a player with no name set.
   */
  players: BookingPlayerDto[];
  /** The court's capacity: the booker plus up to `capacity - 1` added players. */
  capacity: number;
  /** Places left for added players. */
  spotsLeft: number;
  /**
   * Whether players can be added, leave or be removed now: the booking holds
   * its court (PENDING or CONFIRMED) and has not started.
   */
  playersOpen: boolean;
}

/** A person on a booking (#358): what the detail and the participants list show. */
export interface BookingPlayerDto {
  /**
   * What the booker removes them by (`DELETE …/participants/{participantId}`).
   * Null for the booker, who is not removable. Not a user id.
   */
  participantId: string | null;
  name: string | null;
  avatarUrl: string | null;
  isBooker: boolean;
  /** The caller. */
  isYou: boolean;
  /** Has an account, as opposed to a guest named by the booker. */
  registered: boolean;
  /**
   * The account was deleted (#370): its place stays, with `name` and
   * `avatarUrl` null. A client shows "Изтрит потребител".
   */
  deleted: boolean;
}

export function toBookingPlayerDto(p: BookingPlayerDto): BookingPlayerDto {
  return {
    participantId: p.participantId,
    name: p.name,
    avatarUrl: p.avatarUrl,
    isBooker: p.isBooker,
    isYou: p.isYou,
    registered: p.registered,
    deleted: p.deleted,
  };
}

export function toMyBookingDetailDto(
  b: Parameters<typeof toMyBookingDto>[0] & {
    resource: {
      venue: {
        publicSlug: string | null;
        addressLine: string;
        city: string;
        lat: unknown;
        lng: unknown;
        phone: string | null;
      };
    };
    payAtClub: boolean;
    players: BookingPlayerDto[];
    capacity: number;
    spotsLeft: number;
    playersOpen: boolean;
  },
): MyBookingDetailDto {
  const base = toMyBookingDto(b);
  const v = b.resource.venue;
  return {
    ...base,
    venue: {
      ...base.venue,
      publicSlug: v.publicSlug,
      addressLine: v.addressLine,
      city: v.city,
      // Decimal(10,7): a string on the wire without Number() (see the top).
      lat: Number(v.lat),
      lng: Number(v.lng),
      phone: v.phone,
    },
    payAtClub: b.payAtClub,
    players: b.players.map(toBookingPlayerDto),
    capacity: b.capacity,
    spotsLeft: b.spotsLeft,
    playersOpen: b.playersOpen,
  };
}

/** `GET /me/bookings/{id}/participants` (#358). */
export interface BookingParticipantsDto {
  viewerRole: 'BOOKER' | 'PARTICIPANT';
  capacity: number;
  spotsLeft: number;
  playersOpen: boolean;
  /** How many invite links are live. The booker's; null for a participant. */
  liveInviteLinks: number | null;
  players: BookingPlayerDto[];
}

export function toBookingParticipantsDto(p: {
  viewerRole: 'BOOKER' | 'PARTICIPANT';
  capacity: number;
  spotsLeft: number;
  open: boolean;
  liveInviteLinks: number | null;
  players: BookingPlayerDto[];
}): BookingParticipantsDto {
  return {
    viewerRole: p.viewerRole,
    capacity: p.capacity,
    spotsLeft: p.spotsLeft,
    playersOpen: p.open,
    liveInviteLinks: p.liveInviteLinks,
    players: p.players.map(toBookingPlayerDto),
  };
}

/** `POST /me/bookings/{id}/invite-links` (#358). The token is in this answer and nowhere else. */
export interface BookingInviteLinkDto {
  id: string;
  token: string;
  /** The page to share: `/invite/booking/{token}` on this site. */
  url: string;
  /** The booking's start: the link stops working then. */
  expiresAt: string;
}

/** `POST /booking-invites/preview` (#358): nothing private. */
export interface BookingInvitePreviewDto {
  venue: { name: string; city: string; timezone: string };
  /** `resourceType` (P51): see `ResourceSlotsDto.resourceType`. */
  resource: { name: string; sport: string; resourceType: string };
  startTs: string;
  endTs: string;
  bookerFirstName: string | null;
  capacity: number;
  spotsLeft: number;
}

export function toBookingInvitePreviewDto(p: {
  venueName: string;
  venueCity: string;
  timezone: string;
  courtName: string;
  sport: string;
  resourceType: string;
  startTs: Date;
  endTs: Date;
  bookerFirstName: string | null;
  capacity: number;
  spotsLeft: number;
}): BookingInvitePreviewDto {
  return {
    venue: { name: p.venueName, city: p.venueCity, timezone: p.timezone },
    resource: { name: p.courtName, sport: p.sport, resourceType: p.resourceType },
    startTs: rfc3339(p.startTs),
    endTs: rfc3339(p.endTs),
    bookerFirstName: p.bookerFirstName,
    capacity: p.capacity,
    spotsLeft: p.spotsLeft,
  };
}

/** `GET /me/bookings/{id}/co-players` (#358). */
export interface CoPlayerDto {
  /** What `POST …/participants` takes. Only ever a person the caller has played with. */
  userId: string;
  name: string | null;
  avatarUrl: string | null;
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

/**
 * `GET` and `PATCH /api/v1/me`: the account, as `getMe` reads it. Plain
 * strings, numbers and nulls only (no dates), so the use case's shape is the
 * wire shape; named here so client code types against the API, not the
 * app layer.
 */
export type MeDto = Me;

// ─── The bell (#367) ────────────────────────────────────────────────────

/** One bell row as the API answers it. */
export interface NotificationDto {
  id: string;
  kind: string;
  title: string;
  body: string;
  /** A path in the web app (`/me/bookings/{id}`); the iOS app maps `refType`/`refId`. */
  href: string | null;
  refType: string | null;
  refId: string | null;
  read: boolean;
  readAt: string | null;
  createdAt: string;
}

export function toNotificationDto(n: MyNotification): NotificationDto {
  return {
    id: n.id,
    kind: n.kind,
    title: n.title,
    body: n.body,
    href: n.href,
    refType: n.refType,
    refId: n.refId,
    read: n.readAt !== null,
    readAt: n.readAt?.toISOString() ?? null,
    createdAt: n.createdAt.toISOString(),
  };
}

/** `GET`/`PATCH /api/v1/me/notification-settings` (#367): the email switches. */
export type NotificationSettingsDto = NotificationSettings;
