import type { JsonLd } from './venue-jsonld';

/**
 * Structured data for a coach's public page (#547): a schema.org `Person`
 * who works as a coach, with exactly what the page itself shows. Nothing
 * here is not on the page: the name, the picture, the text, the sports, and
 * the places where a lesson can be booked.
 */
export interface CoachJsonLdInput {
  url: string;
  name: string;
  jobTitle: string;
  image: string | null;
  description: string | null;
  /** Sport names in the page's language. */
  sports: readonly string[];
  venues: ReadonlyArray<{ name: string; url: string | null }>;
}

export function buildCoachJsonLd(input: CoachJsonLdInput): JsonLd {
  return {
    '@context': 'https://schema.org',
    '@type': 'Person',
    name: input.name,
    url: input.url,
    jobTitle: input.jobTitle,
    ...(input.image ? { image: input.image } : {}),
    ...(input.description ? { description: input.description.slice(0, 500) } : {}),
    ...(input.sports.length > 0 ? { knowsAbout: [...input.sports] } : {}),
    ...(input.venues.length > 0
      ? {
          workLocation: input.venues.map((v) => ({
            '@type': 'SportsActivityLocation',
            name: v.name,
            ...(v.url ? { url: v.url } : {}),
          })),
        }
      : {}),
  };
}
