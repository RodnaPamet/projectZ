import { getToken } from 'next-auth/jwt';

import { contextFromRequest } from '@/app/api/v1/_lib/context';
import { checkSession } from '@/lib/auth/sessions';
import { membershipContext } from '@/lib/auth/page-context';

jest.mock('next-auth/jwt', () => ({ getToken: jest.fn() }));
jest.mock('@/lib/auth/sessions', () => ({ checkSession: jest.fn() }));
jest.mock('@/lib/auth/page-context', () => ({ membershipContext: jest.fn() }));

/**
 * WHERE in `contextFromRequest` the request-guard checks run — the order is the
 * point. A forged cross-site write is refused before the token is decrypted or
 * the database is read; a stale tab is refused once the session is known to be
 * live, before the membership query.
 */

const mockToken = getToken as unknown as jest.Mock;
const mockCheck = checkSession as unknown as jest.Mock;
const mockMembership = membershipContext as unknown as jest.Mock;

function request(path: string, method: string, headers: Record<string, string>, cookie = false) {
  return {
    nextUrl: new URL(`https://playerz.bg${path}`),
    method,
    headers: { get: (n: string) => headers[n.toLowerCase()] ?? null },
    cookies: {
      getAll: () => (cookie ? [{ name: '__Secure-next-auth.session-token', value: 'jwe' }] : []),
    },
  } as never;
}

beforeEach(() => {
  mockToken.mockReset().mockResolvedValue({ sub: 'usr_b', userSessionId: 's', sessionVersion: 0 });
  mockCheck.mockReset().mockResolvedValue({ usable: true });
  mockMembership.mockReset().mockResolvedValue({ kind: 'not-a-member' });
});

it('refuses a cross-site cookie write before reading the token', async () => {
  const attempt = contextFromRequest(
    request('/api/v1/t/club/bookings', 'POST', { 'sec-fetch-site': 'cross-site' }, true),
    { requestId: 'r', slug: 'club', joinsAsPlayer: true },
  );
  await expect(attempt).rejects.toMatchObject({ name: 'CrossSiteRequestError' });
  expect(mockToken).not.toHaveBeenCalled();
  expect(mockCheck).not.toHaveBeenCalled();
});

it('refuses a stale viewer after the session check and before the membership read', async () => {
  const attempt = contextFromRequest(
    request('/api/v1/t/club/me', 'GET', { 'x-playerz-viewer': 'usr_a' }, true),
    { requestId: 'r', slug: 'club' },
  );
  await expect(attempt).rejects.toMatchObject({ name: 'ViewerChangedError' });
  expect(mockCheck).toHaveBeenCalled();
  expect(mockMembership).not.toHaveBeenCalled();
});

it('a revoked session is anonymous, not a viewer change — the route answers 401', async () => {
  mockCheck.mockResolvedValue({ usable: false, reason: 'revoked' });
  const ctx = await contextFromRequest(
    request('/api/v1/platform/moderation/cases', 'GET', { 'x-playerz-viewer': 'usr_a' }, true),
    { requestId: 'r', platformRoute: true },
  );
  expect(ctx.userId).toBeNull();
});

it('the matching viewer, same-origin, resolves as before', async () => {
  const ctx = await contextFromRequest(
    request(
      '/api/v1/t/club/me',
      'GET',
      { 'x-playerz-viewer': 'usr_b', 'sec-fetch-site': 'same-origin' },
      true,
    ),
    { requestId: 'r', slug: 'club' },
  );
  expect(ctx.userId).toBe('usr_b');
});
