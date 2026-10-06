/**
 * The venue page's structured data (#396): one schema.org
 * `SportsActivityLocation`, emitted server-side as
 * `<script type="application/ld+json">`.
 *
 * ═══ WHY SportsActivityLocation ═══
 *
 * A page here is a VENUE: one address with courts you can book. A club may
 * own several, and each has its own page.
 *
 *   - `SportsActivityLocation` (Place > LocalBusiness > SportsActivityLocation)
 *     is "a sports location, such as a playing field": exactly a venue. As a
 *     LocalBusiness it takes `address`, `geo`, `telephone`, `priceRange` and
 *     `image`, which is what search engines read for local results.
 *   - `SportsClub` is a subtype of it that means the membership organisation.
 *     That is the club (`VenueOrg`), not the venue, and a club with two venues
 *     would claim to be two clubs.
 *   - Plain `LocalBusiness` is correct but says less: nothing in it marks the
 *     place as somewhere to play sport.
 *
 * Sports: schema.org's `sport` property belongs to SportsOrganization, Team
 * and Event, not to a location. A location's facilities are `amenityFeature`
 * (LocationFeatureSpecification), so each sport played is one of those.
 *
 * Nothing here is user-controlled HTML, but names and addresses are free text
 * a club typed: `serializeJsonLd` escapes them so no value can close the
 * script element.
 */

export interface VenueJsonLdCourt {
  /** The price of one `minBookingMinutes` block, before pricing rules. */
  basePriceCents: number;
  minBookingMinutes: number;
  currency: string;
}

export interface VenueJsonLdInput {
  name: string;
  description?: string | null;
  addressLine: string;
  city: string;
  /** ISO 3166-1 alpha-2, e.g. "BG". */
  country: string;
  /** Prisma Decimals arrive as strings or Decimal objects; anything Number() reads. */
  lat?: unknown;
  lng?: unknown;
  phone?: string | null;
  /** The page's canonical absolute URL. */
  url: string;
  /** Photo URLs, absolute or site-relative, best first. Empty: no `image`. */
  images: readonly string[];
  /** Display names of the sports played, in the page's language. */
  sports: readonly string[];
  courts: readonly VenueJsonLdCourt[];
  /** BCP 47 tag used to format `priceRange`, e.g. "bg". */
  locale: string;
}

export type JsonLd = { '@context': 'https://schema.org'; '@type': string } & Record<
  string,
  unknown
>;

function coordinate(value: unknown, limit: number): number | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) && Math.abs(n) <= limit ? n : undefined;
}

/**
 * The hourly base price range across the venue's courts, e.g. "20 € – 30 €".
 *
 * `basePriceCents` is per `minBookingMinutes` block, which differs by court,
 * so each is normalised to an hour first. Pricing rules (peak, weekend) are
 * not applied: they need a time, and `priceRange` is a rough band, not a
 * quote. Courts in more than one currency give no range rather than a wrong
 * one.
 */
export function hourlyPriceRange(
  courts: readonly VenueJsonLdCourt[],
  locale: string,
): string | undefined {
  const priced = courts.filter((c) => c.minBookingMinutes > 0 && c.basePriceCents >= 0);
  if (priced.length === 0) return undefined;
  const currencies = new Set(priced.map((c) => c.currency.toUpperCase()));
  if (currencies.size !== 1) return undefined;
  const [currency] = currencies;

  const hourly = priced.map((c) => Math.round((c.basePriceCents * 60) / c.minBookingMinutes));
  const min = Math.min(...hourly);
  const max = Math.max(...hourly);
  let fmt: Intl.NumberFormat;
  try {
    fmt = new Intl.NumberFormat(locale, {
      style: 'currency',
      currency,
      minimumFractionDigits: 0,
      maximumFractionDigits: 2,
    });
  } catch {
    return undefined; // not an ISO 4217 code
  }
  return min === max
    ? fmt.format(min / 100)
    : `${fmt.format(min / 100)} – ${fmt.format(max / 100)}`;
}

export function buildVenueJsonLd(input: VenueJsonLdInput): JsonLd {
  const latitude = coordinate(input.lat, 90);
  const longitude = coordinate(input.lng, 180);
  const images = input.images.filter(Boolean).map((src) => new URL(src, input.url).toString());
  const priceRange = hourlyPriceRange(input.courts, input.locale);
  const sports = [...new Set(input.sports)];

  return {
    '@context': 'https://schema.org',
    '@type': 'SportsActivityLocation',
    '@id': `${input.url}#venue`,
    name: input.name,
    ...(input.description ? { description: input.description } : {}),
    url: input.url,
    address: {
      '@type': 'PostalAddress',
      streetAddress: input.addressLine,
      addressLocality: input.city,
      addressCountry: input.country,
    },
    ...(latitude !== undefined && longitude !== undefined
      ? { geo: { '@type': 'GeoCoordinates', latitude, longitude } }
      : {}),
    ...(input.phone ? { telephone: input.phone } : {}),
    ...(images.length > 0 ? { image: images } : {}),
    ...(priceRange ? { priceRange } : {}),
    ...(sports.length > 0
      ? {
          amenityFeature: sports.map((name) => ({
            '@type': 'LocationFeatureSpecification',
            name,
            value: true,
          })),
        }
      : {}),
  };
}

/**
 * JSON for inside `<script type="application/ld+json">`.
 *
 * `<` becomes `<`, so no string — a venue called `</script><script>…` —
 * can end the element; `>` and `&` go too, which also rules out `<!--` and
 * entity tricks. U+2028/U+2029 are escaped for old JS parsers. All of these
 * are valid JSON escapes, so a JSON-LD parser reads the original text back.
 */
export function serializeJsonLd(data: unknown): string {
  return JSON.stringify(data)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}
