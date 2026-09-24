/**
 * @jest-environment node
 */
import { NextRequest } from 'next/server';

import { POST as refresh } from '@/app/api/v1/auth/refresh/route';
import { POST as signIn } from '@/app/api/v1/auth/token/route';
import { createUserSession, rotateRefreshToken } from '@/lib/auth/sessions';
import { runAsSuperuser } from '@/lib/db/rls-middleware';
import { verifyCredentials } from '@/lib/auth/verify-credentials';

/**
 * `refreshExpiresAt` must be the SESSION ROW's deadline, not a window measured
 * from the response.
 *
 * Both endpoints used to return `now + REFRESH_TOKEN_TTL_SECONDS`, recomputed
 * on every response — including refreshes that rotated nothing. Nothing ever
 * writes `user_session.expiresAt` after the row is created, and
 * `rotateRefreshToken` rejects against exactly that column, so the advertised
 * value slid forward on every call while the enforced one stood still. A client
 * refreshing daily would read a session that never ends and be signed out
 * without warning on the real deadline.
 *
 * ═══ WHY THESE ARE UNIT TESTS AND NOT ONLY INTEGRATION ONES ═══
 *
 * In production the row is created as `now + NATIVE_SESSION_TTL_SECONDS` and
 * NATIVE_SESSION_TTL_SECONDS is 30 days, the same number the broken code used.
 * A test running against real data therefore cannot tell the two
 * implementations apart at sign-in — both produce the same instant. Mocking the
 * session store lets it return a deadline that is NOT now + 30 days, which is
 * the only way to see which source the response is actually built from.
 *
 * The companion integration tests cover what this cannot: that the value
 * matches the row Postgres really holds, and that it does not move across a
 * real rotation.
 */

// The routes reach the database through `runAsSuperuser`; the unit projects
// have no Postgres. Mocked at this seam rather than replacing
// `@/lib/auth/sessions` wholesale, so the real TTL constants the responses are
// built from still load.
jest.mock('@/lib/db/rls-middleware', () => ({ runAsSuperuser: jest.fn() }));

jest.mock('@/lib/auth/sessions', () => ({
  ...jest.requireActual('@/lib/auth/sessions'),
  rotateRefreshToken: jest.fn(),
  createUserSession: jest.fn(),
  setRefreshToken: jest.fn(async () => undefined),
}));

jest.mock('@/lib/auth/verify-credentials', () => ({ verifyCredentials: jest.fn() }));

const mockRotate = rotateRefreshToken as unknown as jest.Mock;
const mockCreate = createUserSession as unknown as jest.Mock;
const mockSuperuser = runAsSuperuser as unknown as jest.Mock;
const mockVerify = verifyCredentials as unknown as jest.Mock;

/**
 * Deliberately NOT ~30 days from now. Every assertion below would pass on the
 * broken implementation if this were, because that is the number it invented.
 */
const ROW_EXPIRES_AT = new Date('2027-03-09T08:30:00.000Z');
const ROW_EXPIRES_AT_RFC3339 = '2027-03-09T08:30:00Z';

const SESSION_ROW: Record<string, unknown> = {
  sessionVersion: 4,
  expiresAt: ROW_EXPIRES_AT,
};

/**
 * Honours `select` the way Prisma does, so a route that stops selecting a
 * column gets `undefined` here rather than a value the fake volunteered. That
 * is what makes "delete `expiresAt` from the select" a failing mutation and not
 * a silent pass.
 */
const findUniqueOrThrow = jest.fn((args: { select: Record<string, true> }) =>
  Promise.resolve(Object.fromEntries(Object.keys(args.select).map((k) => [k, SESSION_ROW[k]]))),
);

let ipCounter = 0;

const post = (url: string, body: unknown) =>
  new NextRequest(url, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: {
      'content-type': 'application/json',
      // A fresh address per request: LOGIN_LIMIT keeps a process-local Map that
      // no reset touches, so a shared IP would 429 later tests.
      'x-forwarded-for': `10.77.0.${(ipCounter++ % 250) + 1}`,
    },
  });

const dataOf = async (res: Response) => {
  // Asserted here so a route that 500s fails naming the status, rather than
  // ten lines later on a property of `undefined`.
  expect(res.status).toBe(200);
  return ((await res.json()) as { data: Record<string, string | number | null> }).data;
};

beforeEach(() => {
  mockRotate.mockReset();
  mockCreate.mockReset();
  mockVerify.mockReset();
  findUniqueOrThrow.mockClear();

  mockSuperuser.mockReset();
  mockSuperuser.mockImplementation((run: (db: unknown) => unknown) =>
    run({ userSession: { findUniqueOrThrow } }),
  );
});

describe('POST /auth/refresh — refreshExpiresAt', () => {
  const rotated = {
    ok: true,
    userId: 'usr_1',
    userSessionId: 'ses_1',
    refreshToken: 'a-new-refresh-token',
    rotated: true,
  };

  it('reports the session row deadline, not now + the refresh TTL', async () => {
    mockRotate.mockResolvedValue(rotated);

    const res = await refresh(
      post('http://t/api/v1/auth/refresh', { refreshToken: 'old' }),
      undefined,
    );
    expect(res.status).toBe(200);

    expect((await dataOf(res)).refreshExpiresAt).toBe(ROW_EXPIRES_AT_RFC3339);
  });

  it('a rotation does NOT push the deadline out — the row is never rewritten', async () => {
    // The rotating update writes the token hashes, the grace deadline and
    // lastSeenAt. `expiresAt` is not in it, so refreshing buys no extra time
    // and the response must not imply that it does.
    mockRotate.mockResolvedValue(rotated);

    const first = await dataOf(
      await refresh(post('http://t/api/v1/auth/refresh', { refreshToken: 'old' }), undefined),
    );
    const second = await dataOf(
      await refresh(
        post('http://t/api/v1/auth/refresh', { refreshToken: 'a-new-refresh-token' }),
        undefined,
      ),
    );

    expect(second.refreshExpiresAt).toBe(first.refreshExpiresAt);
    expect(second.refreshExpiresAt).toBe(ROW_EXPIRES_AT_RFC3339);
  });

  it('inside the grace window — nothing rotated — it is the same deadline', async () => {
    // This is the response the bug was loudest on: the server did not move the
    // session on, kept the same refresh token, and still advertised another
    // thirty days.
    mockRotate.mockResolvedValue({
      ok: true,
      userId: 'usr_1',
      userSessionId: 'ses_1',
      refreshToken: null,
      rotated: false,
    });

    const d = await dataOf(
      await refresh(post('http://t/api/v1/auth/refresh', { refreshToken: 'previous' }), undefined),
    );

    expect(d.refreshToken).toBeNull();
    expect(d.refreshExpiresAt).toBe(ROW_EXPIRES_AT_RFC3339);
  });

  it('reads the deadline from the session it just refreshed', async () => {
    mockRotate.mockResolvedValue({ ...rotated, userSessionId: 'ses_other' });

    await refresh(post('http://t/api/v1/auth/refresh', { refreshToken: 'old' }), undefined);

    expect(findUniqueOrThrow).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'ses_other' } }),
    );
  });
});

describe('POST /auth/token — refreshExpiresAt', () => {
  const DAY_MS = 24 * 60 * 60 * 1000;

  beforeEach(() => {
    mockVerify.mockResolvedValue({ id: 'usr_1' });
    mockCreate.mockResolvedValue({
      userSessionId: 'ses_1',
      sessionVersion: 0,
      expiresAt: ROW_EXPIRES_AT,
    });
  });

  it('reports the deadline the session store recorded, not its own arithmetic', async () => {
    const d = await dataOf(
      await signIn(
        post('http://t/api/v1/auth/token', { email: 'p@playerz.test', password: 'pw' }),
        undefined,
      ),
    );

    expect(d.refreshExpiresAt).toBe(ROW_EXPIRES_AT_RFC3339);
  });

  it('still sizes the session row to the whole refresh window', async () => {
    // The other half of the contract. Reporting the row's expiry faithfully is
    // no use if the row itself is created too short — the refresh token would
    // then die before the deadline the client was handed.
    await signIn(
      post('http://t/api/v1/auth/token', { email: 'p@playerz.test', password: 'pw' }),
      undefined,
    );

    const requested = (mockCreate.mock.calls[0][0] as { expiresAt: Date }).expiresAt;
    expect(requested.getTime() - Date.now()).toBeGreaterThan(29 * DAY_MS);
  });
});
