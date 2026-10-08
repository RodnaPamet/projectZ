import { existsSync, globSync } from 'node:fs';
import path from 'node:path';

/**
 * EVERY NAVIGABLE PAGE HAS A LOADING STATE (T12, #267 follow-up).
 *
 * ═══ WHY ═══
 *
 * PR #268's navigation baseline found no loading UI in any of 1,280
 * client-side navigations. A phone tap waited 190-540 ms with the previous
 * page frozen on screen, because without a `loading.tsx` a default prefetch
 * fetches only the route tree and the router has nothing to paint until the
 * whole server render arrives. A new page that forgets its `loading.tsx`
 * brings that back for its own route, silently: nothing fails, the tap just
 * feels dead again.
 *
 * ═══ THE RULE ═══
 *
 * Every `page.tsx` under src/app has a `loading.tsx` in its OWN segment, or an
 * entry below saying why not. "Its own segment", not an ancestor's: a list
 * page that fell back to another page's skeleton would flash the wrong shape.
 *
 * ═══ NEVER A ROOT loading.tsx ═══
 *
 * A `src/app/loading.tsx` wraps EVERY layout and page in a Suspense boundary,
 * so every response starts streaming (status 200) before any layout or page
 * has run. A `redirect()` or `notFound()` after that point can no longer set
 * the status: it becomes a client-side redirect or a soft 404. Measured on
 * T12's first draft, which had one: `/t/{slug}` (where every club user lands)
 * stopped being an HTTP 307 and became a 200 that redirected from the
 * browser, one extra document hop. Its prefetches, started by the page being
 * left, also never finished in Chrome and stalled the perf harness's staff
 * journey on desktop for minutes. The home page's skeleton lives in the
 * `(home)` route group instead, where it wraps nothing but the home page.
 *
 * An entry that no longer matches a page, or whose page has since gained a
 * loading.tsx, fails too — an allow-list that only grows stops meaning
 * anything.
 */

const APP = 'src/app';

/** Segment directory (relative to src/app) → why it has no loading.tsx. */
const NO_LOADING: Record<string, string> = {
  offline:
    'force-static: served from the service worker with no request to wait on, so there is no navigation to cover',
  '(app)/t/[slug]':
    'redirect-only index: it sends a club user on to the diary, whose own loading.tsx is what paints',
  '(app)/platform':
    'redirect-only index (#345, audit M03): it sends a grant holder on to the first platform page the grant opens, whose own loading.tsx is what paints',
  '(design)/design-system':
    'developer-facing component gallery, not linked from the app; no user navigates to it',
  // The legal pages (#370): a missing text must answer a REAL 404. A
  // loading.tsx streams a 200 before the page runs, and notFound() after that
  // is a soft 404 (Next's docs, file-conventions/loading.md, "Status Codes").
  '(public)/privacy':
    'a missing text answers HTTP 404 (#370), which a loading boundary would turn into a streamed 200; the page reads one file from disk, nothing to wait on',
  '(public)/terms':
    'a missing text answers HTTP 404 (#370), which a loading boundary would turn into a streamed 200; the page reads one file from disk, nothing to wait on',
  '(public)/cookies':
    'a missing text answers HTTP 404 (#370), which a loading boundary would turn into a streamed 200; the page reads one file from disk, nothing to wait on',
};

const pages = globSync(`${APP}/**/page.tsx`)
  .map((f) => path.relative(APP, path.dirname(f.toString())).split(path.sep).join('/'))
  .map((dir) => (dir === '' ? '.' : dir))
  .sort();

const hasLoading = (dir: string) => existsSync(path.join(APP, dir, 'loading.tsx'));

describe('route loading coverage', () => {
  it('finds the pages it is meant to cover', () => {
    // A glob that silently matched nothing would pass every test below.
    expect(pages).toEqual(
      expect.arrayContaining([
        '(home)',
        '(public)/venues',
        '(public)/me/bookings',
        '(app)/t/[slug]/admin/calendar',
      ]),
    );
  });

  it.each(pages)('%s has a loading.tsx, or a stated reason not to', (dir) => {
    if (hasLoading(dir)) return;
    expect({
      dir,
      reason: NO_LOADING[dir] ?? 'MISSING: add loading.tsx or an allow-list entry',
    }).toEqual({ dir, reason: expect.not.stringMatching(/^MISSING/) });
  });

  it.each(Object.keys(NO_LOADING))('allow-list entry %s is not stale', (dir) => {
    expect(pages).toContain(dir);
    expect(hasLoading(dir)).toBe(false);
  });

  it('there is no root loading.tsx (it would stream every redirect and 404)', () => {
    expect(existsSync(path.join(APP, 'loading.tsx'))).toBe(false);
  });

  it('every loading.tsx sits beside a page', () => {
    // A loading.tsx with no page beside it covers a whole subtree by accident.
    const orphans = globSync(`${APP}/**/loading.tsx`)
      .map((f) => path.relative(APP, path.dirname(f.toString())).split(path.sep).join('/'))
      .map((dir) => (dir === '' ? '.' : dir))
      .filter((dir) => !pages.includes(dir));
    expect(orphans).toEqual([]);
  });
});
