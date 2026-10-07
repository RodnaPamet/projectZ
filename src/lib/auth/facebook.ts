/**
 * Facebook Login (#361): the constants and the two judgements its sign-in
 * makes. Pure, with no server imports, because the login form needs the
 * refusal code and the re-request parameter on the client.
 *
 * ═══ THE GRAPH API VERSION IS PINNED HERE, NOT IN NEXT-AUTH ═══
 *
 * next-auth 4.24's `FacebookProvider` sends people to
 * `https://www.facebook.com/v11.0/dialog/oauth`, and asks Graph for the token
 * and the profile with no version at all — the app's default, a setting in
 * Meta's dashboard rather than in this repository. v11.0 was retired in 2023.
 * Meta "defaults" a call to a retired version "to the next oldest, usable
 * version", so it keeps working — on whichever version Meta picks that month,
 * not one anybody here tested, and changing under us as old versions expire.
 *
 * So `src/auth.ts` overrides all three endpoints with this version. v26.0 is
 * the newest on Meta's changelog (introduced 2026-07-29), and Meta keeps each
 * version "for at least 2 years from release". Bump it here, and nowhere
 * else, when a newer one is out.
 *
 * ═══ THE REDIRECT URI IS FIXED BY THE PROVIDER ID ═══
 *
 * next-auth builds it as `${NEXTAUTH_URL}/api/auth/callback/<id>`, and the
 * Facebook app registers it in strict mode, which compares the whole string.
 * The id is `facebook`, so the callback is `/api/auth/callback/facebook` on
 * every host the app runs on. Renaming the provider would break sign-in at
 * Meta, after the person has already agreed.
 */

/** https://developers.facebook.com/docs/graph-api/changelog/ */
export const FACEBOOK_GRAPH_VERSION = 'v26.0';

export const FACEBOOK_AUTHORIZATION_URL = `https://www.facebook.com/${FACEBOOK_GRAPH_VERSION}/dialog/oauth`;
export const FACEBOOK_TOKEN_URL = `https://graph.facebook.com/${FACEBOOK_GRAPH_VERSION}/oauth/access_token`;
export const FACEBOOK_USERINFO_URL = `https://graph.facebook.com/${FACEBOOK_GRAPH_VERSION}/me`;

/**
 * `email` is what the account is found by, and the reason for the whole
 * no-email path below. `public_profile` (name, picture) is granted to every app
 * anyway; asking for it says so on the consent screen.
 */
export const FACEBOOK_SCOPE = 'email public_profile';

/** What `/me` is asked for. Nothing else is read. */
export const FACEBOOK_USERINFO_FIELDS = 'id,name,email,picture';

/**
 * The refusal when Facebook sends no email address — the `?error=` the login
 * page explains, with a way to ask again.
 *
 * Facebook leaves `email` out when the person unticked it on the consent
 * screen, and when the account has no usable address (some are phone-only).
 * The account is found BY email, so without one there is nothing to sign into,
 * and an account without one could never be found again. Nothing is created.
 */
export const FACEBOOK_EMAIL_REQUIRED = 'FacebookEmailRequired';

/**
 * Sent through `/api/auth/signin` rather than to `/login` directly: next-auth
 * answers that path by redirecting to the sign-in page with the callback URL
 * from its own cookie attached. The sign-in callback cannot see that URL, and
 * without it an invitation's `?next=` would be lost on the refusal — the
 * person would sign in on the second try and land somewhere else.
 */
export const FACEBOOK_EMAIL_REQUIRED_REDIRECT = `/api/auth/signin?error=${FACEBOOK_EMAIL_REQUIRED}`;

/**
 * Asking again for a permission the person declined.
 *
 * The Login Dialog does not offer a declined permission a second time unless
 * it is told this is a re-request:
 * https://developers.facebook.com/docs/facebook-login/handling-declined-permissions
 * next-auth's `signIn(provider, options, authorizationParams)` appends it to
 * the dialog URL.
 */
export const FACEBOOK_REREQUEST = { auth_type: 'rerequest' } as const;

// ─── The picture ─────────────────────────────────────────────────────

/**
 * Where Facebook serves profile pictures from.
 *
 * Graph's `picture` is a SIGNED URL — `platform-lookaside.fbsbx.com/...` with
 * an expiry (`ext`) and a signature (`hash`) — that stops working some weeks
 * after it was issued. Google's `picture` is a stable URL; this one is a loan.
 */
const FACEBOOK_PICTURE_DOMAINS = ['fbsbx.com', 'fbcdn.net'] as const;

/** Is this a picture URL Facebook issued — one that will expire? */
export function isFacebookPictureUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const host = parsed.hostname.toLowerCase();
  return FACEBOOK_PICTURE_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`));
}

/**
 * The picture in a Graph `/me` response, or null.
 *
 * Defensive, because next-auth's own `profile()` for this provider reads
 * `profile.picture.data.url` unguarded: a response without a picture throws
 * inside next-auth's `getProfile`, which swallows the error and sends the
 * person back to the sign-in page with no message at all.
 *
 * `is_silhouette` is Facebook's grey placeholder for "no picture". The
 * initials say that better than a stranger's outline does.
 */
export function facebookPictureFrom(profile: unknown): string | null {
  const data = (profile as { picture?: { data?: { url?: unknown; is_silhouette?: unknown } } })
    ?.picture?.data;
  if (!data || data.is_silhouette === true) return null;
  return typeof data.url === 'string' && data.url.startsWith('https://') ? data.url : null;
}

/**
 * Should a Facebook sign-in write the picture it just brought?
 *
 * Only over nothing, or over a picture Facebook issued earlier — which by now
 * may have expired. Never over anything else: a Google picture is stable, and
 * the account's first provider chose it.
 */
export function facebookRefreshesAvatar(stored: string | null): boolean {
  return stored === null || isFacebookPictureUrl(stored);
}
