import type { MetadataRoute } from 'next';

import { env } from '@/env';
import { listSitemapClubs, listSitemapVenues } from '@/app-layer/repositories/venue';
import { runAsSuperuser } from '@/lib/db/rls-middleware';
import { buildSitemap, SITEMAP_MAX_VENUES } from '@/lib/seo/sitemap';
import { siteUrl } from '@/lib/seo/site-url';

/**
 * /sitemap.xml (#396): `/`, `/venues`, and every public venue page whose
 * venue and club are both ACTIVE, with `lastModified` from the venue row; and
 * every such venue's club page, `/clubs/{slug}` (#356) — never a SUSPENDED or
 * CLOSED club's, whose page is a 404.
 *
 * Rendered per request, not at build time: the build has no database (the
 * Docker image is built without one), and a sitemap frozen at deploy would
 * miss every club that signs up after it. The read is one indexed scan plus
 * one lookup by primary key; crawlers fetch this a few times a day.
 *
 * BYPASSRLS, like the venue index and the venue page: there is no tenant to
 * bind, and `venue` is FORCE RLS. `listSitemapVenues` selects only the slug
 * and the date.
 */
export const dynamic = 'force-dynamic';

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  // Staging (#373) lists nothing: robots.txt already disallows the whole host.
  if (env.DEPLOY_ENV === 'staging') return [];
  const { venues, clubs } = await runAsSuperuser(async (db) => {
    const venues = await listSitemapVenues(db, SITEMAP_MAX_VENUES);
    return { venues, clubs: await listSitemapClubs(db, venues) };
  });
  return buildSitemap(siteUrl(), venues, clubs);
}
