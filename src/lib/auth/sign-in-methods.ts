import { passwordSignInEnabled } from './password-sign-in';

/**
 * Which ways in are actually configured.
 *
 * ═══ WHY THIS EXISTS ═══
 *
 * The OAuth providers used to be registered unconditionally, with `?? ''`
 * standing in for absent credentials. That does not fail at startup. It renders
 * a "Sign in with Google" button that carries the user to Google and fails
 * THERE, on a page the operator cannot see and the user cannot act on.
 *
 * `src/auth.ts` now registers a provider only when its pair is present, so the
 * button is simply not offered. That is better, and it is also silent — which
 * is the failure mode #166 was opened about: APNs was off, correctly, and
 * nothing anywhere said so.
 *
 * So this reports it, next to `pushChannels()` on `/api/ready`, for the same
 * reason and in the same shape.
 *
 * `configured` means the credentials are PRESENT. Whether Google or Meta
 * accepts them is between the provider and the deployment; no readiness probe
 * can answer that without attempting a sign-in.
 *
 * ═══ ONE ANSWER, READ BY BOTH ═══
 *
 * `src/auth.ts` registers providers with `googleConfigured`,
 * `facebookConfigured` and `passwordSignInEnabled`, and the login page decides
 * its buttons from `signInMethods()`, which reads the same three. A page that
 * offered a button for a provider auth.ts had not registered would send people
 * to next-auth's error page; one predicate per provider makes that impossible
 * to write.
 */
export type MethodState = 'configured' | 'disabled';

export interface SignInMethods {
  /** Google OAuth. */
  google: MethodState;
  /** Facebook Login (#361), provider id `facebook`. */
  facebook: MethodState;
  /**
   * Email and password.
   *
   * `disabled` in every deployment: it exists for the test suites, which set
   * `TEST_PASSWORD_SIGN_IN=1` with `DEPLOY_ENV=test` (#361). Reported anyway,
   * because it is also the only grant `POST /api/v1/auth/token` has — a
   * native client looking at this sees why that endpoint refuses.
   */
  credentials: MethodState;
}

type Env = Readonly<Record<string, string | undefined>>;

// Both halves, because a provider registered with half a credential pair is
// exactly the broken button this is here to prevent. An empty string is
// absent: `GOOGLE_CLIENT_ID=` in a .env sets one.
const pair = (id: string | undefined, secret: string | undefined): boolean =>
  Boolean(id) && Boolean(secret);

export function googleConfigured(env: Env = process.env): boolean {
  return pair(env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET);
}

export function facebookConfigured(env: Env = process.env): boolean {
  return pair(env.FACEBOOK_CLIENT_ID, env.FACEBOOK_CLIENT_SECRET);
}

const state = (present: boolean): MethodState => (present ? 'configured' : 'disabled');

export function signInMethods(env: Env = process.env): SignInMethods {
  return {
    google: state(googleConfigured(env)),
    facebook: state(facebookConfigured(env)),
    credentials: state(passwordSignInEnabled(env)),
  };
}
