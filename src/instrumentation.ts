/**
 * Runs once per server instance, before the first request is served.
 *
 * Next calls `register` in EVERY runtime, so anything that cannot run on the
 * edge must be behind a `NEXT_RUNTIME` check and a dynamic import — the check
 * alone is not enough, because a static import is bundled for both runtimes
 * regardless of which branch executes. This repo has already been bitten twice
 * by that shape: `next-intl/server` behind a `react-server` condition, and
 * `pg` reaching jsdom through `context.ts`.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    await import('./instrumentation-node');
  }
}
