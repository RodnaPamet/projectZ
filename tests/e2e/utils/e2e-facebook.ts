/**
 * The Meta app the E2E server is configured with (#361): a placeholder.
 *
 * It exists so `/login` offers "Вход с Facebook" under test, and so
 * facebook-sign-in.spec.ts can read what the app sends to Meta. The spec
 * intercepts the dialog, so nothing ever reaches Facebook — and if anything
 * did, these could not sign anybody in.
 *
 * Set on the webServer by playwright.config.ts, over whatever the shell holds,
 * so the spec can pin `client_id` exactly.
 */
export const E2E_FACEBOOK_APP_ID = 'e2e-placeholder-meta-app';
export const E2E_FACEBOOK_APP_SECRET = 'e2e-placeholder-meta-secret'; // pragma: allowlist secret
