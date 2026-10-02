import { existsSync, globSync } from 'node:fs';

import { clubAdminNav, platformNav, type NavItem } from '@/components/layout/nav-items';

/**
 * EVERY NAV LINK HAS A PAGE BEHIND IT (#260).
 *
 * The club nav linked `/t/{slug}/open-play`, `/coaches` and `/my-bookings`,
 * and none of the three pages ever existed. Each was a link to a 404 on the
 * most visible surface in the app, and each prefetched that 404 as it entered
 * the viewport; Chrome never reports those requests as finished (#267), so
 * they also stalled the perf harness. Nothing failed: a link is a string, and
 * no test followed it.
 *
 * This follows every href the builders produce, for a sample slug, to the
 * `page.tsx` that would serve it under `src/app`. Route groups (`(app)`) are
 * not in the URL, and a dynamic segment (`[slug]`) matches any value, so the
 * href is matched against each page's route pattern rather than joined into a
 * path.
 */

const SAMPLE_SLUG = 'sample-club';

/** `src/app/(app)/t/[slug]/admin/courts/page.tsx` → `^/t/[^/]+/admin/courts$`. */
function routePattern(pageFile: string): RegExp {
  const segments = pageFile
    .replace(/^src\/app\//, '')
    .replace(/\/?page\.tsx$/, '')
    .split('/')
    .filter((s) => s && !/^\(.*\)$/.test(s));
  const body = segments
    .map((s) => (/^\[.+\]$/.test(s) ? '[^/]+' : s.replace(/[.*+?^${}()|\\]/g, '\\$&')))
    .join('/');
  return new RegExp(`^/${body}$`);
}

const PAGES = globSync('src/app/**/page.tsx').map((f) => f.toString());
const PATTERNS = PAGES.map((f) => ({ file: f, re: routePattern(f) }));

const HREFS = [...clubAdminNav(SAMPLE_SLUG), ...platformNav()]
  .flatMap((s): NavItem[] => s.items)
  .map((i) => i.href);

describe('nav hrefs resolve to pages', () => {
  it('found the pages and the hrefs it checks', () => {
    // A glob that matched nothing would make every assertion below vacuous.
    expect(PAGES.length).toBeGreaterThan(10);
    expect(HREFS.length).toBeGreaterThanOrEqual(6);
  });

  it.each(HREFS)('%s has a page.tsx', (href) => {
    const path = href.split(/[?#]/)[0]!;
    const served = PATTERNS.filter((p) => p.re.test(path)).map((p) => p.file);
    expect({ href, served: served.length > 0 }).toEqual({ href, served: true });
  });

  it('the matcher would catch a dead link', () => {
    // Negative control: #260's three links, which must NOT resolve.
    for (const dead of ['open-play', 'coaches', 'my-bookings']) {
      const path = `/t/${SAMPLE_SLUG}/${dead}`;
      expect(PATTERNS.some((p) => p.re.test(path))).toBe(false);
    }
    // Positive control: a page known to exist, through a group and a dynamic segment.
    expect(existsSync('src/app/(app)/t/[slug]/admin/calendar/page.tsx')).toBe(true);
    expect(PATTERNS.some((p) => p.re.test(`/t/${SAMPLE_SLUG}/admin/calendar`))).toBe(true);
  });
});
