import { buildRobots, ROBOTS_DISALLOW } from '@/lib/seo/robots';
import { buildSitemap, venuePath } from '@/lib/seo/sitemap';
import { absoluteUrl, resolveSiteUrl } from '@/lib/seo/site-url';

describe('the canonical site URL (#396)', () => {
  it('prefers SITE_URL, then NEXTAUTH_URL, then localhost', () => {
    expect(
      resolveSiteUrl({ SITE_URL: 'https://playerz.bg', NEXTAUTH_URL: 'https://app.playerz.bg' })
        .href,
    ).toBe('https://playerz.bg/');
    expect(resolveSiteUrl({ NEXTAUTH_URL: 'https://app.playerz.bg' }).href).toBe(
      'https://app.playerz.bg/',
    );
    expect(resolveSiteUrl({}).href).toBe('http://localhost:3000/');
  });

  it('keeps only the origin, and skips a value that is not an http(s) URL', () => {
    expect(resolveSiteUrl({ SITE_URL: 'https://playerz.bg/some/path?x=1' }).href).toBe(
      'https://playerz.bg/',
    );
    expect(
      resolveSiteUrl({ SITE_URL: 'not a url', NEXTAUTH_URL: 'https://app.playerz.bg' }).href,
    ).toBe('https://app.playerz.bg/');
    expect(resolveSiteUrl({ SITE_URL: 'javascript:alert(1)' }).href).toBe('http://localhost:3000/');
  });

  it('builds absolute URLs on that origin', () => {
    expect(absoluteUrl('/venues/x', new URL('https://playerz.bg'))).toBe(
      'https://playerz.bg/venues/x',
    );
  });
});

describe('buildSitemap (#396)', () => {
  const origin = new URL('https://playerz.bg');

  it('lists / and /venues, then one entry per venue with its own lastModified', () => {
    const a = new Date('2026-09-01T10:00:00Z');
    const b = new Date('2026-10-02T08:30:00Z');
    const map = buildSitemap(origin, [
      { publicSlug: 'arena-sofia', updatedAt: a },
      { publicSlug: 'padel-lozenets', updatedAt: b },
    ]);

    expect(map.map((e) => e.url)).toEqual([
      'https://playerz.bg/',
      'https://playerz.bg/venues',
      'https://playerz.bg/venues/arena-sofia',
      'https://playerz.bg/venues/padel-lozenets',
    ]);
    expect(map[2].lastModified).toBe(a);
    expect(map[3].lastModified).toBe(b);
    // /venues changed when its newest venue did; / has no honest date.
    expect(map[1].lastModified).toBe(b);
    expect(map[0].lastModified).toBeUndefined();
  });

  it('gives /venues no date when there are no venues', () => {
    const map = buildSitemap(origin, []);
    expect(map).toHaveLength(2);
    expect(map[1].lastModified).toBeUndefined();
  });

  it('encodes the slug into the path', () => {
    expect(venuePath('a b')).toBe('/venues/a%20b');
  });
});

describe('buildRobots (#396)', () => {
  const robots = buildRobots(new URL('https://playerz.bg'));
  const rules = Array.isArray(robots.rules) ? robots.rules : [robots.rules];

  it('points at the sitemap on the canonical origin', () => {
    expect(robots.sitemap).toBe('https://playerz.bg/sitemap.xml');
  });

  it('allows the site and disallows every private area', () => {
    expect(rules).toHaveLength(1);
    expect(rules[0].userAgent).toBe('*');
    expect(rules[0].allow).toBe('/');
    expect(rules[0].disallow).toEqual([...ROBOTS_DISALLOW]);
    for (const path of [
      '/me/',
      '/t/*/admin',
      '/platform',
      '/api/',
      '/start',
      '/invite/',
      '/login',
    ]) {
      expect(ROBOTS_DISALLOW).toContain(path);
    }
  });

  /**
   * robots.txt rules as Google applies them: prefix match, `*` any run of
   * characters, a trailing `$` anchors the end. Enough to check the list does
   * what it means against real paths.
   */
  function blocked(path: string): boolean {
    return ROBOTS_DISALLOW.some((rule) => {
      const anchored = rule.endsWith('$');
      const body = (anchored ? rule.slice(0, -1) : rule)
        .split('*')
        .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .join('.*');
      return new RegExp(`^${body}${anchored ? '$' : ''}`).test(path);
    });
  }

  it.each([
    '/me',
    '/me/bookings',
    '/t/club-sofia/admin',
    '/t/club-sofia/admin/courts',
    '/platform/moderation',
    '/api/v1/venues',
    '/start',
    '/invite/abc',
    '/login?next=/venues/x',
  ])('blocks %s', (path) => {
    expect(blocked(path)).toBe(true);
  });

  it.each([
    '/',
    '/venues',
    '/venues/arena-sofia',
    '/venues/arena-sofia?day=2026-10-07',
    '/t/club-sofia',
    '/media',
  ])('leaves %s crawlable', (path) => {
    expect(blocked(path)).toBe(false);
  });
});

describe('robots.txt on staging (#373)', () => {
  it('disallows everything and names no sitemap', () => {
    const robots = buildRobots(new URL('https://staging.example.test'), 'staging');
    expect(robots.rules).toEqual([{ userAgent: '*', disallow: '/' }]);
    expect(robots.sitemap).toBeUndefined();
  });

  it('is unchanged in production, which stays the default', () => {
    const origin = new URL('https://playerz.bg');
    expect(buildRobots(origin, 'production')).toEqual(buildRobots(origin));
  });
});
