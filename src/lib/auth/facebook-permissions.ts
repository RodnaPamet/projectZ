import { createHmac } from 'node:crypto';

import {
  emailPermissionFrom,
  FACEBOOK_PERMISSIONS_URL,
  type FacebookEmailPermission,
} from '@/lib/auth/facebook';

/** Long enough for Graph, short enough that a refusal is never slow. */
const LOOKUP_TIMEOUT_MS = 3000;

/**
 * What the person's Facebook grant says about `email`, read with the token
 * their sign-in just received. Server-only (`node:crypto`), so it lives apart
 * from `@/lib/auth/facebook`, which the login form imports.
 *
 * It runs on the refusal path only, when Graph's `/me` came back without an
 * address, and it decides which refusal the person sees: "allow access to your
 * email and try again", or "Facebook has no address to give" (see
 * `FACEBOOK_EMAIL_UNAVAILABLE`). The first real sign-in hit the second, and
 * without this lookup the page could only suggest the first.
 *
 * The token goes in the Authorization header, never in the URL.
 * `appsecret_proof` is what Graph demands of server calls when the Meta app
 * turns on "Require app secret"; with it off, it is ignored.
 *
 * It never throws: the person is refused either way, and this only chooses
 * the words. Any failure is `unknown`.
 */
export async function readFacebookEmailPermission(
  accessToken: string | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<FacebookEmailPermission> {
  if (!accessToken) return 'unknown';

  const url = new URL(FACEBOOK_PERMISSIONS_URL);
  const secret = process.env.FACEBOOK_CLIENT_SECRET;
  if (secret) {
    url.searchParams.set(
      'appsecret_proof',
      createHmac('sha256', secret).update(accessToken).digest('hex'),
    );
  }

  try {
    const res = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
      cache: 'no-store',
      signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
    });
    if (!res.ok) return 'unknown';
    return emailPermissionFrom(await res.json());
  } catch {
    return 'unknown';
  }
}
