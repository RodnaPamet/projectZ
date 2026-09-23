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
