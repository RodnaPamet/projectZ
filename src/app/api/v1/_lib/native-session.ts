import type { NextRequest } from 'next/server';

import {
  mintAccessToken,
  NATIVE_SESSION_TTL_SECONDS,
  rfc3339,
  type NativeTokens,
} from '@/app/api/v1/_lib/native-token';
import { createUserSession, newSessionSecret, setRefreshToken } from '@/lib/auth/sessions';

/**
 * The end of every native sign-in (#444, #442): the password grant, the
 * provider grants, and the Apple hidden-address confirm all issue the same
 * pair from here, so a session made one way is the session made any other.
 */
/** A session row, its refresh token, and an access token for it. */
export async function issueTokens(
  req: NextRequest,
  userId: string,
  ip: string,
): Promise<NativeTokens> {
  const now = Date.now();
  const sessionSecret = newSessionSecret();
  const refreshToken = newSessionSecret();

  const {
    userSessionId,
    sessionVersion,
    expiresAt: sessionExpiresAt,
  } = await createUserSession({
    userId,
    tenantId: null,
    sessionSecret,
    // The ROW lives as long as the refresh window, not the access token. A row
    // that died with the access token would revoke a refresh token the client
    // still legitimately holds.
    expiresAt: new Date(now + NATIVE_SESSION_TTL_SECONDS * 1000),
    ipAddress: ip,
    // So a session list can name the device. The web path leaves both null.
    userAgent: req.headers.get('user-agent'),
  });

  await setRefreshToken(userSessionId, refreshToken);

  const { accessToken, expiresAt } = await mintAccessToken({
    sub: userId,
    userSessionId,
    sessionVersion,
  });

  return {
    tokenType: 'Bearer',
    accessToken,
    expiresAt: rfc3339(expiresAt),
    expiresIn: Math.floor((expiresAt.getTime() - now) / 1000),
    refreshToken,
    // The ROW's expiry, as stored — not a window measured from this response.
    // `rotateRefreshToken` rejects against that column and nothing ever writes
    // it again, so this is the only value that stays true as the session is
    // refreshed. /auth/refresh returns the same column for the same reason.
    refreshExpiresAt: rfc3339(sessionExpiresAt),
  };
}
