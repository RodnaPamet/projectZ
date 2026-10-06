import type { MetadataRoute } from 'next';

import { listSitemapVenues } from '@/app-layer/repositories/venue';
import { runAsSuperuser } from '@/lib/db/rls-middleware';
import { buildSitemap, SITEMAP_MAX_VENUES } from '@/lib/seo/sitemap';
import { siteUrl } from '@/lib/seo/site-url';

/**
 * /sitemap.xml (#396): `/`, `/venues`, and every public venue page whose
 * venue and club are both ACTIVE, with `lastModified` from the venue row.
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
  const venues = await runAsSuperuser((db) => listSitemapVenues(db, SITEMAP_MAX_VENUES));
  return buildSitemap(siteUrl(), venues);
}
