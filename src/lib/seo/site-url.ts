/**
 * The canonical public origin (#396): the one host search engines are told
 * about, in the sitemap, robots.txt, `<link rel="canonical">`, Open Graph and
 * JSON-LD.
 *
 * `SITE_URL` when set, else `NEXTAUTH_URL` (the origin the app is served on;
 * deploy/add-domain.sh points both at the canonical host). Both are declared
 * and validated in src/env.ts; this reads `process.env` so the pure builders
 * in this folder can be unit-tested without the whole env schema.
 *
 * The production host is moving to playerz.bg (Q47). Nothing here names a
 * host, so that move is a change to .env and not to code.
 */
const DEV_ORIGIN = 'http://localhost:3000';

export function resolveSiteUrl(env: {
  SITE_URL?: string | undefined;
  NEXTAUTH_URL?: string | undefined;
}): URL {
  for (const candidate of [env.SITE_URL, env.NEXTAUTH_URL]) {
    if (!candidate) continue;
    try {
      const url = new URL(candidate);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') continue;
      // The ORIGIN only: a path or query on the setting would otherwise leak
      // into every URL built from it.
      return new URL(url.origin);
    } catch {
      // Not a URL (src/env.ts refuses one at boot); try the next.
    }
  }
  return new URL(DEV_ORIGIN);
}

export function siteUrl(): URL {
  return resolveSiteUrl(process.env);
}

/** `path` on the canonical origin, as an absolute string. */
export function absoluteUrl(path: string, origin: URL = siteUrl()): string {
  return new URL(path, origin).toString();
}
