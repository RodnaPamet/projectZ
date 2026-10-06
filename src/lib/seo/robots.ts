import type { MetadataRoute } from 'next';

import { absoluteUrl } from './site-url';

/**
 * robots.txt (#396): crawl the public pages, stay out of everything behind a
 * session, and find the sitemap.
 *
 * robots.txt is advice, not access control. Every path below is already
 * guarded by middleware or the route itself; listing it here only saves
 * crawl budget and keeps sign-in redirects out of search results.
 *
 * Rules are PREFIX matches. `/me` is written as `/me$` + `/me/` so it cannot
 * also swallow a future public `/media` or `/members`; the others are long
 * or distinctive enough that a prefix is what is meant.
 */
export const ROBOTS_DISALLOW = [
  // The player area.
  '/me$',
  '/me/',
  // A club's back office. The club page `/t/{slug}` itself is left alone.
  '/t/*/admin',
  // Platform administration.
  '/platform',
  // JSON, not pages. The venue pages fetch it; crawlers need not.
  '/api/',
  // Onboarding, invitations and sign-in: per-person flows, nothing to index.
  '/start',
  '/invite/',
  '/login',
  // The component showcase and the service worker's offline fallback.
  '/design-system',
  '/offline',
] as const;

/**
 * Staging (#373) is a full copy of the site on another host. Nothing on it may
 * be indexed, or search results would split between the two hosts: disallow
 * everything, and name no sitemap.
 */
export function buildRobots(
  origin: URL,
  deployEnv: 'production' | 'staging' = 'production',
): MetadataRoute.Robots {
  if (deployEnv === 'staging') {
    return { rules: [{ userAgent: '*', disallow: '/' }] };
  }
  return {
    rules: [{ userAgent: '*', allow: '/', disallow: [...ROBOTS_DISALLOW] }],
    sitemap: absoluteUrl('/sitemap.xml', origin),
  };
}
