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
 * `configured` means the credentials are PRESENT. Whether Google accepts them
 * is between Google and the deployment; no readiness probe can answer that
 * without attempting a sign-in.
 */
export type MethodState = 'configured' | 'disabled';

export interface SignInMethods {
  /** Google OAuth. */
  google: MethodState;
  /** Microsoft Entra (registered under next-auth v4's `azure-ad` id). */
  microsoft: MethodState;
  /**
   * Email and password.
   *
   * Always on today, and deliberately reported anyway: it is the only method
   * the NATIVE client can use — `POST /api/v1/auth/token` is email/password —
   * so anyone considering turning it off needs to see that it is load-bearing
   * for more than the web login form.
   */
  credentials: MethodState;
}

const state = (present: boolean): MethodState => (present ? 'configured' : 'disabled');

export function signInMethods(): SignInMethods {
  return {
    // Both halves, because a provider registered with half a credential pair is
    // exactly the broken button this is here to prevent.
    google: state(
      Boolean(process.env.GOOGLE_CLIENT_ID) && Boolean(process.env.GOOGLE_CLIENT_SECRET),
    ),
    microsoft: state(
      Boolean(process.env.MICROSOFT_CLIENT_ID) && Boolean(process.env.MICROSOFT_CLIENT_SECRET),
    ),
    credentials: 'configured',
  };
}
