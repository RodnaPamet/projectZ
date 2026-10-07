/**
 * Email and password: for the test suites, and nowhere else (#361, Q15/Q21).
 *
 * Everyone signs in with Google or Facebook. The owner kept email+password for
 * one reason — the suites sign in programmatically as seeded accounts — and
 * decided it is never enabled in production.
 *
 * Until #361 it was registered unconditionally, so password sign-in was live
 * in production: `POST /api/auth/callback/credentials` and the native
 * `POST /api/v1/auth/token` both answered, for any account that had a
 * `passwordHash`. None did (measured 2026-10-07), so nothing was exposed, but
 * one seeded or scripted row would have been enough.
 *
 * ═══ ONE FLAG, AND IT IS NOT ENOUGH ON ITS OWN ═══
 *
 * `TEST_PASSWORD_SIGN_IN=1` turns it on, and only where `DEPLOY_ENV=test`
 * says this process is a test run rather than a deployment. Both, because each
 * alone fails open in a way that matters:
 *
 *   - the flag alone: one line copied from `.env.test` into a deployment's
 *     `.env` would put passwords back in production, silently;
 *   - "refuse only when DEPLOY_ENV=production": production's `.env` does not
 *     set DEPLOY_ENV at all. Unset MEANS production (`src/env.ts` defaults it),
 *     so a check on the literal would never fire where it matters.
 *
 * So everything that is not explicitly `test` counts as a deployment —
 * unset, `production`, `staging`, and any value nobody anticipated.
 *
 * ═══ AND A DEPLOYMENT THAT CARRIES THE FLAG DOES NOT START ═══
 *
 * `passwordSignInEnabled` already answers "no" in a deployment, whatever the
 * flag says, so the flag cannot turn passwords on there. That is the silent
 * half. `assertPasswordSignInNotDeployed` is the loud half: called first in
 * `src/instrumentation-node.ts`, it stops a deployment whose environment
 * carries the flag at all — the process exits with this error before serving
 * a request. A configuration that can only be a mistake is surfaced within
 * seconds of the deploy instead of being ignored.
 *
 * Who sets the pair: `jest.setup.ts` (unit and integration), the Playwright
 * webServer (`playwright.config.ts`) and the perf harness
 * (`tests/perf/serve.ts`). Nothing in `deploy/` does, and nothing should.
 */

type Env = Readonly<Record<string, string | undefined>>;

/** The variable that turns password sign-in on. Test runs only. */
export const PASSWORD_SIGN_IN_FLAG = 'TEST_PASSWORD_SIGN_IN';

/**
 * The deployment this process says it is. Unset is production, exactly as
 * `src/env.ts` defaults it — read here from `process.env` because the startup
 * check runs before anything else and must not depend on env validation, which
 * a build or CI may skip.
 */
export function deployEnvOf(env: Env = process.env): string {
  return env.DEPLOY_ENV || 'production';
}

/**
 * True unless DEPLOY_ENV says, explicitly, that this is a test run.
 *
 * An allow-list of one. A deny-list of `production` and `staging` would admit
 * a typo (`prod`) and, worse, the unset value production actually runs with.
 */
export function isDeployment(env: Env = process.env): boolean {
  return deployEnvOf(env) !== 'test';
}

/** Whether email+password sign-in exists in this process. */
export function passwordSignInEnabled(env: Env = process.env): boolean {
  return env.TEST_PASSWORD_SIGN_IN === '1' && !isDeployment(env);
}

export class PasswordSignInInDeploymentError extends Error {
  constructor(deployEnv: string, explicit: boolean) {
    super(
      `Refusing to start: ${PASSWORD_SIGN_IN_FLAG} is set, and this is a deployment ` +
        `(DEPLOY_ENV=${deployEnv}${explicit ? '' : ', because DEPLOY_ENV is unset'}).\n\n` +
        `Email and password sign-in exists for the test suites only (#361). In a deployment\n` +
        `everyone signs in with Google or Facebook, and the flag has no business being in\n` +
        `this environment at all — the only way it gets here is by mistake.\n\n` +
        `Fix: remove ${PASSWORD_SIGN_IN_FLAG} from this deployment's .env. It is honoured only\n` +
        `with DEPLOY_ENV=test, which the E2E, perf and Jest harnesses set for themselves.`,
    );
    this.name = 'PasswordSignInInDeploymentError';
  }
}

/**
 * The startup check. Throws if a deployment's environment carries the flag.
 *
 * ANY non-empty value refuses, not only `1`: `TEST_PASSWORD_SIGN_IN=true` turns
 * nothing on, but it says somebody tried, in production, and that is what has
 * to be looked at. An empty value (`TEST_PASSWORD_SIGN_IN=` in a `.env`) is the
 * same as unset.
 */
export function assertPasswordSignInNotDeployed(env: Env = process.env): void {
  if (!env.TEST_PASSWORD_SIGN_IN) return;
  if (isDeployment(env)) {
    throw new PasswordSignInInDeploymentError(deployEnvOf(env), Boolean(env.DEPLOY_ENV));
  }
}
