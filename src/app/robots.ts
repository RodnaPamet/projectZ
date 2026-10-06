import type { MetadataRoute } from 'next';

import { env } from '@/env';
import { buildRobots } from '@/lib/seo/robots';
import { siteUrl } from '@/lib/seo/site-url';

/**
 * /robots.txt (#396). Per request, not at build time, so the `Sitemap:` line
 * names the origin in the RUNNING container's SITE_URL — the image is built
 * once and the host is moving (Q47).
 */
export const dynamic = 'force-dynamic';

export default function robots(): MetadataRoute.Robots {
  return buildRobots(siteUrl(), env.DEPLOY_ENV);
}
