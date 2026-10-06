import type { MetadataRoute } from 'next';

import { absoluteUrl } from './site-url';

/**
 * sitemap.xml's entries (#396), built from data the caller has already read,
 * so the shape is unit-testable without a database. src/app/sitemap.ts reads
 * the venues; this decides what the file says about them.
 */

/** One public venue page. Already filtered to ACTIVE venues of ACTIVE clubs. */
export interface SitemapVenue {
  publicSlug: string;
  updatedAt: Date;
}

/** One public club page (#356). Already filtered to ACTIVE clubs with a listed venue. */
export interface SitemapClub {
  slug: string;
  updatedAt: Date;
}

/**
 * A sitemap file may list at most 50,000 URLs (sitemaps.org). Two are the
 * fixed pages; the rest is headroom no single file will reach before a
 * sitemap index is needed — at which point this cap is where to split.
 */
export const SITEMAP_MAX_VENUES = 49_000;

export function venuePath(publicSlug: string): string {
  return `/venues/${encodeURIComponent(publicSlug)}`;
}

/**
 * A club's public page (#356). `/clubs/{slug}`, beside `/venues/{publicSlug}`,
 * not under `/t/{slug}`: that prefix is the members' tenant namespace, gated
 * at the edge and in the layout (see src/app/(public)/clubs/[slug]/page.tsx).
 */
export function clubPath(slug: string): string {
  return `/clubs/${encodeURIComponent(slug)}`;
}

export function buildSitemap(
  origin: URL,
  venues: readonly SitemapVenue[],
  clubs: readonly SitemapClub[] = [],
): MetadataRoute.Sitemap {
  // /venues changes whenever a venue on it does; `/` has no data-backed date,
  // and a made-up one (the request time) teaches crawlers to ignore the field.
  const newest = venues.reduce<Date | undefined>(
    (max, v) => (!max || v.updatedAt > max ? v.updatedAt : max),
    undefined,
  );

  return [
    { url: absoluteUrl('/', origin), changeFrequency: 'weekly', priority: 1 },
    {
      url: absoluteUrl('/venues', origin),
      ...(newest ? { lastModified: newest } : {}),
      changeFrequency: 'daily',
      priority: 0.9,
    },
    ...venues.map((v) => ({
      url: absoluteUrl(venuePath(v.publicSlug), origin),
      lastModified: v.updatedAt,
      // Free times change all day; the page itself (name, address, courts)
      // changes when updatedAt says it did.
      changeFrequency: 'daily' as const,
      priority: 0.8,
    })),
    // A club page lists its venues and their free times today: it changes as
    // often as they do, and ranks with them.
    ...clubs.map((c) => ({
      url: absoluteUrl(clubPath(c.slug), origin),
      lastModified: c.updatedAt,
      changeFrequency: 'daily' as const,
      priority: 0.8,
    })),
  ];
}
