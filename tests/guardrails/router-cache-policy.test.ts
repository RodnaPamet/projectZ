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
};

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
    const page = readFileSync('src/app/(app)/t/[slug]/admin/calendar/page.tsx', 'utf8');
    expect(code(grid)).toMatch(/useRefreshWhenStale\(renderedAt\)/);
    expect(code(page)).toMatch(/renderedAt=\{/);
  });

  it('finds the source it scans', () => {
    expect(sources.length).toBeGreaterThan(50);
  });

  it.each(sources)('%s: no prefetch={true} or router.prefetch outside the allow-list', (f) => {
    if (f in FULL_PREFETCH_ALLOWED) return;
    const src = code(readFileSync(f, 'utf8'));
    const hits = [
      // prefetch={true}, and the bare JSX attribute `prefetch`, which means true.
      ...src.matchAll(/\bprefetch\s*=\s*\{\s*true\s*\}/g),
      ...src.matchAll(/<\w[^>]*\sprefetch(?=[\s/>])/g),
      ...src.matchAll(/\brouter\.prefetch\s*\(/g),
    ].map((m) => m[0]);
    expect({ file: f, hits }).toEqual({ file: f, hits: [] });
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
    const scan = (s: string) =>
      /\bprefetch\s*=\s*\{\s*true\s*\}/.test(code(s)) ||
      /<\w[^>]*\sprefetch(?=[\s/>])/.test(code(s)) ||
      /\brouter\.prefetch\s*\(/.test(code(s));
    expect(scan('<Link href="/t/x/admin/courts" prefetch={true}>')).toBe(true);
    expect(scan('<Link href="/x" prefetch>')).toBe(true);
    expect(scan('router.prefetch(href)')).toBe(true);
    expect(scan('<Link href="/x" prefetch={false}>')).toBe(false);
    expect(scan('// callers do router.prefetch(href)')).toBe(false);
  });
});
