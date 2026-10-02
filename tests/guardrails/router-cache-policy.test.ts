import { existsSync, globSync, readFileSync } from 'node:fs';

import { STALE_AFTER_MS } from '@/lib/hooks/use-refresh-when-stale';

/**
 * THE ROUTER-CACHE AND PREFETCH POLICY (T30, docs/perf/navigation-policy.md).
 *
 * ═══ WHY ═══
 *
 * With `staleTimes.dynamic` at 0 the client cache kept nothing: every revisit
 * paid a round trip, and since T12's loading.tsx it also paid React's 300 ms
 * Suspense reveal throttle (#290). 30 s of cache is what makes a revisit
 * paint from memory. Two things quietly undo or abuse that, and both are
 * one-line changes nobody would question in review:
 *
 *   - staleTimes edited, or dropped in a config refactor. The warm rows of
 *     the perf baseline go back to a round trip plus the throttle.
 *   - `prefetch={true}` (or router.prefetch) on an admin link. A FULLY
 *     prefetched route lives under `staleTimes.static`, 180 s, so the diary
 *     could be three minutes old on the tap; and every revalidating admin
 *     write purges the cache and re-prefetches each such link in the
 *     viewport, in full. The player tab bar (T20) is the one place full
 *     prefetch is worth it: its pages revalidate through SWR after paint.
 *     The anonymous home page's /venues and /login links are the other
 *     (#290), through PublicPrefetchLink, pinned to exactly those two.
 *
 * So both are pinned here, and the diary's self-refresh with them: a cached
 * diary younger than the cache window must refresh itself, or the front desk
 * sees a 30 s old day.
 */

const config = readFileSync('next.config.mjs', 'utf8');

/** Full-prefetch sites, and why. Anything else fails. */
const FULL_PREFETCH_ALLOWED: Record<string, string> = {
  'src/components/layout/BottomTabBar.tsx':
    "T20's player tab bar, allow-listed ahead of it: its pages (/venues, /me) read through SWR and revalidate after paint, so a 180 s old shell is refreshed on arrival. It skips full prefetch under Save-Data.",
  'src/components/layout/PublicPrefetchLink.tsx':
    "The anonymous home page's links to /venues and /login (#290): 1.4-2.4 KB, the same for every visitor, and a first visit then renders from the router cache instead of waiting out the 300 ms reveal throttle. It skips full prefetch under Save-Data. Where it may be used is pinned below.",
  'src/components/layout/nav-item.tsx':
    'Vendored from inflect (T19), byte-identical, so it cannot change here. It passes its caller\'s `prefetch` to <Link>, defaulting to inflect\'s full prefetch (inflect #3100 added the prop). Every playerz <NavItem> must pass prefetch="auto" as a literal, which the rule below pins.',
};

/**
 * Where a vendored component takes `prefetch` as a prop and defaults it to
 * full, every playerz use must pass the literal "auto". The allow-list above
 * trusts the component; this is what makes that safe.
 */
const AUTO_ONLY_COMPONENTS = ['NavItem'];

/**
 * Exactly where PublicPrefetchLink may appear, and to which page. A new use,
 * above all one in the club admin, fails here and has to argue its case in
 * docs/perf/navigation-policy.md first.
 */
const PUBLIC_PREFETCH_SITES: Record<string, string[]> = {
  'src/app/(home)/page.tsx': ['/venues'],
  'src/components/layout/SiteHeader.tsx': ['/login'],
};

/**
 * prefetch={true}, any computed value (prefetch={x ? null : true}), and the
 * bare JSX attribute `prefetch`, which means true. Only the literals false and
 * null, and the string "auto", are the default or less.
 */
const FULL_PREFETCH = [
  /\bprefetch\s*=\s*\{(?!\s*(?:false|null|'auto'|"auto")\s*\})[^}]*\}/g,
  /<\w[^>]*\sprefetch(?=[\s/>])/g,
  /\brouter\.prefetch\s*\(/g,
];

/** Code only: comments may mention the patterns they explain. */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const sources = globSync('src/**/*.{ts,tsx}').map((f) => f.toString());

describe('router cache policy', () => {
  it('pins staleTimes to { dynamic: 30, static: 180 }', () => {
    const m = /staleTimes:\s*\{\s*dynamic:\s*(\d+),\s*static:\s*(\d+)\s*\}/.exec(code(config));
    expect(m && { dynamic: Number(m[1]), static: Number(m[2]) }).toEqual({
      dynamic: 30,
      static: 180,
    });
  });

  it('the diary refreshes itself inside the dynamic window', () => {
    expect(STALE_AFTER_MS).toBeLessThan(30_000);
    const grid = readFileSync('src/app/(app)/t/[slug]/admin/calendar/DayGrid.tsx', 'utf8');
    const fresh = readFileSync(
      'src/app/(app)/t/[slug]/admin/calendar/use-fresh-diary-day.ts',
      'utf8',
    );
    const day = readFileSync('src/app/(app)/t/[slug]/admin/calendar/diary-day.ts', 'utf8');
    expect(code(grid)).toMatch(/useFreshDiaryDay\(/);
    expect(code(fresh)).toMatch(/useRefreshWhenStale\(newest\.renderedAt, refresh\)/);
    expect(code(day)).toMatch(/renderedAt: now\.getTime\(\)/);
  });

  /**
   * #314. `router.refresh()` purges the WHOLE router cache (Next 16.3.6 bumps
   * one global segment-cache version), and so does a Server Action that
   * revalidates a path or tag or sets a cookie. The diary's stale refresh used
   * the first, so every diary revisit after 10 s turned every other warm admin
   * screen cold. It now re-fetches only the day, through an action that must
   * stay a pure read.
   */
  it('the diary’s stale refresh re-fetches the day, never the router or a revalidation', () => {
    const hook = code(readFileSync('src/lib/hooks/use-refresh-when-stale.ts', 'utf8'));
    expect(hook).not.toMatch(/router\.refresh|useRouter/);

    const fresh = code(
      readFileSync('src/app/(app)/t/[slug]/admin/calendar/use-fresh-diary-day.ts', 'utf8'),
    );
    expect(fresh).toMatch(/refreshDiaryDayAction\(/);
    expect(fresh).not.toMatch(/router\.refresh|useRouter/);

    const actions = code(readFileSync('src/app/(app)/t/[slug]/admin/calendar/actions.ts', 'utf8'));
    const start = actions.indexOf('export async function refreshDiaryDayAction');
    expect(start).toBeGreaterThan(-1);
    const next = actions.indexOf('export ', start + 1);
    const body = actions.slice(start, next === -1 ? undefined : next);
    expect(body).not.toMatch(
      /revalidatePath|revalidateTag|updateTag|refresh\(|cookies\(|redirect\(/,
    );
  });

  it('finds the source it scans', () => {
    expect(sources.length).toBeGreaterThan(50);
  });

  it.each(sources)('%s: no prefetch={true} or router.prefetch outside the allow-list', (f) => {
    if (f in FULL_PREFETCH_ALLOWED) return;
    const src = code(readFileSync(f, 'utf8'));
    const hits = FULL_PREFETCH.flatMap((re) => [...src.matchAll(re)].map((m) => m[0]));
    expect({ file: f, hits }).toEqual({ file: f, hits: [] });
  });

  it.each(sources)('%s: every vendored NavItem is told prefetch="auto"', (f) => {
    const src = code(readFileSync(f, 'utf8'));
    for (const name of AUTO_ONLY_COMPONENTS) {
      const uses = [...src.matchAll(new RegExp(`<${name}\\b[^>]*>`, 'g'))].map((m) => m[0]);
      const unpinned = uses.filter((u) => !/\sprefetch="auto"/.test(u));
      expect({ file: f, component: name, unpinned }).toEqual({
        file: f,
        component: name,
        unpinned: [],
      });
    }
  });

  it('the NavItem rule would catch a full or missing prefetch', () => {
    const unpinned = (s: string) =>
      [...s.matchAll(/<NavItem\b[^>]*>/g)].filter((m) => !/\sprefetch="auto"/.test(m[0])).length;
    expect(unpinned('<NavItem href="/x" label="x" prefetch="auto" />')).toBe(0);
    expect(unpinned('<NavItem href="/x" label="x" />')).toBe(1);
    expect(unpinned('<NavItem href="/x" prefetch={true} />')).toBe(1);
  });

  it.each(sources)('%s: PublicPrefetchLink only where pinned', (f) => {
    const src = code(readFileSync(f, 'utf8'));
    const uses = src.match(/<PublicPrefetchLink\b/g)?.length ?? 0;
    const hrefs = [...src.matchAll(/<PublicPrefetchLink\b[^>]*?\shref="([^"]*)"/g)].map(
      (m) => m[1],
    );
    expect({ file: f, uses, hrefs }).toEqual({
      file: f,
      uses: PUBLIC_PREFETCH_SITES[f]?.length ?? 0,
      hrefs: PUBLIC_PREFETCH_SITES[f] ?? [],
    });
  });

  it('every pinned PublicPrefetchLink site exists', () => {
    for (const f of Object.keys(PUBLIC_PREFETCH_SITES)) expect(existsSync(f)).toBe(true);
  });

  it.each(Object.keys(FULL_PREFETCH_ALLOWED))(
    'allow-list entry %s has a reason (it may land after this rule)',
    (f) => {
      expect(FULL_PREFETCH_ALLOWED[f]!.length).toBeGreaterThan(40);
      // Allow-listed ahead of T20. Once it exists, it must be under src/components/layout.
      if (existsSync(f)) expect(f.startsWith('src/components/layout/')).toBe(true);
    },
  );

  it('the ban would catch what it bans', () => {
    const scan = (s: string) => FULL_PREFETCH.some((re) => [...code(s).matchAll(re)].length > 0);
    expect(scan('<Link href="/t/x/admin/courts" prefetch={true}>')).toBe(true);
    expect(scan('<Link href="/x" prefetch={saveData ? null : true}>')).toBe(true);
    expect(scan('<Link href="/x" prefetch={full}>')).toBe(true);
    expect(scan('<Link href="/x" prefetch={null}>')).toBe(false);
    expect(scan('<Link href="/x" prefetch="auto">')).toBe(false);
    expect(scan('<Link href="/x" prefetch>')).toBe(true);
    expect(scan('router.prefetch(href)')).toBe(true);
    expect(scan('<Link href="/x" prefetch={false}>')).toBe(false);
    expect(scan('// callers do router.prefetch(href)')).toBe(false);
  });
});
