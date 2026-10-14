import { existsSync, globSync } from 'node:fs';

import { ENTRY_POINTS, reachableFromEntryPoints } from './reachable-from-routes';

/**
 * EVERY USE CASE IS REACHABLE FROM A ROUTE — OR SAYS WHY NOT.
 *
 * ═══ THE PATTERN THIS EXISTS FOR ═══
 *
 * Eleven of eighteen modules in src/app-layer/usecases/ had no path to a
 * route. They are not stubs: `createSplit` mints CSPRNG tokens with a 48-hour
 * TTL and hash-only storage, `notify` fanned out to APNs and Web Push. They
 * work. Nothing calls them.
 *
 * That would be ordinary unfinished work, except the doc comments describe
 * them as live. `createSplit` says the raw token is "returned ONCE, to be
 * emailed"; nothing emails it, and no route creates or redeems a split.
 * `findSplitByToken` says an expiry is "checked here rather than only in the
 * UI, because the UI is not what a POST has to get past" — there is no POST.
 *
 * So a reader cannot tell a shipped feature from a designed one, and the audit
 * that found this had to check eleven modules one at a time to learn which was
 * which. This makes the answer a declaration instead.
 *
 * ═══ REACHABILITY, NOT IMPORT COUNT ═══
 *
 * "Does anything outside this directory import it?" gives the wrong answer for
 * `wallet`: no route imports it, but `payments` does, and a route imports
 * `payments`. It is live. So the walk is transitive from the routes.
 *
 * That distinction is not academic — it moved four modules. `wallet`,
 * `pricing`, `refund` and `booking-split` all look orphaned by a direct-import
 * count and are all reached through a sibling. Only seven modules are
 * genuinely unreachable, not the eleven a shallower count reports.
 *
 * MODULE granularity, deliberately. `booking-split` is reachable because
 * `payments` imports `assertSharesSumToTotal` from it — while `createSplit`
 * and `findSplitByToken` in that same directory still have no caller outside
 * tests. A per-export rule would be more precise and would also fire on every
 * legitimately-unused helper, which is how a ratchet earns its way into
 * somebody's ignore list.
 */

const USE_CASES = globSync('src/app-layer/usecases/*.ts')
  .map((f) => f.toString())
  .filter((f) => !f.endsWith('.d.ts'));

/**
 * Not reachable from a route, and that is a decision rather than an accident.
 *
 * Each entry says what it is waiting on. The rule is that the module's own doc
 * comments must not describe it as running — the thing that made this
 * expensive to discover was prose written in the present tense about code with
 * no callers.
 */
const NOT_WIRED_YET: Record<string, string> = {
  gamification: 'XP and achievements have no surface yet',
  wearables: 'the Strava importer runs from a script, never from a request',
};

describe('use-case reachability', () => {
  const reachable = reachableFromEntryPoints();

  it('the walk found the entry points and followed them somewhere', () => {
    // A resolver that returns null for everything would make the assertion
    // below trivially satisfied by the allowlist, which is the exact shape of
    // a vacuous ratchet.
    expect(ENTRY_POINTS.length).toBeGreaterThan(10);
    expect(USE_CASES.length).toBeGreaterThan(10);
    expect(reachable.size).toBeGreaterThan(ENTRY_POINTS.length * 2);

    // And that it genuinely crosses into the app layer rather than stopping at
    // the route files.
    expect(reachable.has('src/app-layer/usecases/booking.ts')).toBe(true);
  });

  it('every use case is reachable from a route, or declared not-wired', () => {
    const orphans = USE_CASES.filter((f) => !reachable.has(f))
      .map((f) => f.replace(/^src\/app-layer\/usecases\//, '').replace(/\.ts$/, ''))
      .filter((name) => !(name in NOT_WIRED_YET));

    if (orphans.length > 0) {
      throw new Error(
        `Use cases nothing can reach from a route:\n\n` +
          orphans.map((o) => `  ${o}`).join('\n') +
          `\n\nThis is not automatically wrong — half this directory is deliberate\n` +
          `scaffolding. It is wrong to be UNDECLARED, because the next reader\n` +
          `cannot tell a shipped feature from a designed one without tracing\n` +
          `every import by hand.\n\n` +
          `Either wire it to a route, or add it to NOT_WIRED_YET saying what it\n` +
          `is waiting on — and make sure its doc comments do not describe it in\n` +
          `the present tense as though it runs.`,
      );
    }
  });

  it('nothing on the not-wired list has quietly become reachable', () => {
    // The ratchet direction. Wiring a module up means deleting its line, so
    // the list shrinks as the product grows and cannot silently keep excusing
    // something that no longer needs excusing.
    const nowLive = Object.keys(NOT_WIRED_YET).filter((name) =>
      reachable.has(`src/app-layer/usecases/${name}.ts`),
    );

    expect(nowLive).toEqual([]);
  });

  it('every not-wired entry points at a module that exists', () => {
    // A stale name is an exemption for a file somebody could recreate.
    const missing = Object.keys(NOT_WIRED_YET).filter(
      (name) => !existsSync(`src/app-layer/usecases/${name}.ts`),
    );

    expect(missing).toEqual([]);
  });

  it('every not-wired entry says what it is waiting on', () => {
    const unexplained = Object.entries(NOT_WIRED_YET)
      .filter(([, reason]) => reason.trim().length <= 20)
      .map(([name]) => name);

    expect(unexplained).toEqual([]);
  });
});
