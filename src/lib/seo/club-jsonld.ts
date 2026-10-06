import type { JsonLd } from './venue-jsonld';

/**
 * The club page's structured data (#356): one schema.org `SportsClub`, whose
 * `location` is each of its venues.
 *
 * ═══ SportsClub HERE, SportsActivityLocation ON THE VENUE PAGE ═══
 *
 * venue-jsonld.ts explains the split: a venue is a place you book courts at,
 * a club (`VenueOrg`) is the organisation that runs one or more of them.
 * `SportsClub` is that organisation — and, being a LocalBusiness, it may carry
 * the address and phone people reach it by.
 *
 * Each venue is `location`, not `subOrganization`: a venue is a place, not
 * an organisation. Its `@id` is the one the venue page gives its own
 * `SportsActivityLocation` (`{venueUrl}#venue`), so a crawler that reads both
 * pages joins them into one graph instead of seeing two unrelated places.
 *
 * Sports: `sport` is a SportsOrganization property, which SportsClub is not
 * (it descends from SportsActivityLocation only), so the sports go on each
 * venue as `amenityFeature`, as the venue page itself does.
 */

export interface ClubJsonLdVenue {
  name: string;
  /** The venue page's canonical absolute URL. */
  url: string;
  addressLine: string;
  city: string;
  country: string;
  /** Display names of the sports played there, in the page's language. */
  sports: readonly string[];
  /** The venue's cover, absolute (#366). Omitted: no `image`. */
  image?: string | null;
}

export interface ClubJsonLdInput {
  name: string;
  /** The club page's canonical absolute URL. */
  url: string;
  phone?: string | null;
  logoUrl?: string | null;
  /** The club's cover photo URLs, absolute, best first (#366). Empty: no `image`. */
  images?: readonly string[];
  /** The address people are pointed to: the club's main (first) venue's. */
  address?: { addressLine: string; city: string; country: string } | null;
  venues: readonly ClubJsonLdVenue[];
}

function postalAddress(a: { addressLine: string; city: string; country: string }) {
  return {
    '@type': 'PostalAddress',
    streetAddress: a.addressLine,
    addressLocality: a.city,
    addressCountry: a.country,
  };
}

export function buildClubJsonLd(input: ClubJsonLdInput): JsonLd {
  return {
    '@context': 'https://schema.org',
    '@type': 'SportsClub',
    '@id': `${input.url}#club`,
    name: input.name,
    url: input.url,
    ...(input.phone ? { telephone: input.phone } : {}),
    ...(input.logoUrl ? { logo: new URL(input.logoUrl, input.url).toString() } : {}),
    ...(input.images && input.images.length > 0
      ? { image: input.images.map((src) => new URL(src, input.url).toString()) }
      : {}),
    ...(input.address ? { address: postalAddress(input.address) } : {}),
    ...(input.venues.length > 0
      ? {
          location: input.venues.map((v) => ({
            '@type': 'SportsActivityLocation',
            '@id': `${v.url}#venue`,
            name: v.name,
            url: v.url,
            address: postalAddress(v),
            ...(v.image ? { image: new URL(v.image, v.url).toString() } : {}),
            ...(v.sports.length > 0
              ? {
                  amenityFeature: [...new Set(v.sports)].map((name) => ({
                    '@type': 'LocationFeatureSpecification',
                    name,
                    value: true,
                  })),
                }
              : {}),
          })),
        }
      : {}),
  };
}
