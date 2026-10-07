/**
 * The landing page's structured data (#369): who runs the site
 * (`Organization`) and the site itself (`WebSite`), as one `@graph`.
 *
 * Both carry an `@id` on the canonical origin (`SITE_URL`, #401), so a crawler
 * joins them: the WebSite's `publisher` is the Organization. The venue and
 * club pages describe places and clubs; this is the only page that describes
 * playerz itself.
 *
 * No `SearchAction`: Google retired the sitelinks search box in 2024, and an
 * `?q=` template would advertise a search the index page does not promise to
 * keep. No `logo` either until the app has an icon file to point at (the
 * manifest names /icons/*, which do not exist yet).
 */
export interface SiteJsonLdInput {
  /** The canonical origin, e.g. `https://playerz.bg/`. */
  origin: URL;
  /** The product name, a brand: `playerz.bg`. */
  name: string;
  /** One sentence, in the page's language. */
  description: string;
  /** The page's language, BCP 47 (`bg`, `en`). */
  language: string;
}

/** The `@graph` the landing page serialises: Organization, WebSite and the WebPage. */
export function siteGraph(input: SiteJsonLdInput): {
  '@context': 'https://schema.org';
  '@graph': Record<string, unknown>[];
} {
  const url = new URL('/', input.origin).toString();
  const orgId = `${url}#organization`;
  const siteId = `${url}#website`;
  return {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'Organization',
        '@id': orgId,
        name: input.name,
        url,
        areaServed: { '@type': 'City', name: 'Sofia' },
      },
      {
        '@type': 'WebSite',
        '@id': siteId,
        name: input.name,
        url,
        description: input.description,
        inLanguage: ['bg', 'en'],
        publisher: { '@id': orgId },
      },
      {
        '@type': 'WebPage',
        '@id': `${url}#webpage`,
        url,
        name: input.name,
        description: input.description,
        inLanguage: input.language,
        isPartOf: { '@id': siteId },
        about: { '@id': orgId },
      },
    ],
  };
}
