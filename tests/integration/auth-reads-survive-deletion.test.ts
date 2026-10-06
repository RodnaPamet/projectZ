/**
 * #419: a user (or club) deleted while a request is reading it is SIGNED OUT,
 * not a 500.
 *
 * CI's E2E server log on fc8b4b5 showed
 *
 *     TypeError: Cannot read properties of null (reading 'sessionVersion')
 *
 * Mapped through that build's source maps, it was `checkSession`
 * (src/lib/auth/sessions.ts, `row.user.sessionVersion`) called from
 * `requireSignedIn` on /me/bookings. The booking-detail spec's fixture had
 * deleted its player while the page was still rendering.
 *
 * Prisma 7 loads `user` with a second select, so the session row came back and
 * the user did not: `user: null` on a relation the schema calls required.
 * `interleavingClient` commits the delete in exactly that gap, every time.
 */
import type { PrismaClient } from '@prisma/client';

import { membershipContext, requireSignedIn } from '@/lib/auth/page-context';
import {
  checkSession,
  createUserSession,
  newSessionSecret,
  rotateRefreshToken,
  setRefreshToken,
} from '@/lib/auth/sessions';
import { assertFreshStepUp } from '@/lib/auth/step-up';
import { PlatformStepUpRequiredError } from '@/lib/auth/mfa-errors';

import { prismaTestClient, seedTenant } from '../helpers/db';
import {
  afterSelectFrom,
  disconnectInterleavingClient,
  hookPending,
  interleavingClient,
} from '../helpers/interleave';
import { asAppSuperuser } from '../helpers/rls';

// Every `runAsSuperuser` without an explicit client goes through the
// interleaving one, so the code under test is the real code, unmodified.
jest.mock('@/lib/db/rls-middleware', () => {
  const actual = jest.requireActual('@/lib/db/rls-middleware');
  return {
    ...actual,
    runAsSuperuser: (fn: unknown, client?: unknown, opts?: unknown) =>
      actual.runAsSuperuser(
        fn,
        client ?? jest.requireActual('../helpers/interleave').interleavingClient(),
        opts,
      ),
  };
});

const mockToken = { current: null as Record<string, unknown> | null };
jest.mock('next/headers', () => ({
  cookies: async () => ({}),
  headers: async () => ({}),
}));
jest.mock('next-auth/jwt', () => ({ getToken: async () => mockToken.current }));

describe('auth reads when the row is deleted mid-read (#419)', () => {
  const db = prismaTestClient();

  afterAll(async () => {
    await disconnectInterleavingClient();
  });

  /** An undecided account (`accountKind: null`), as a first sign-in makes since #360. */
  async function signedInUser() {
    const user = await asAppSuperuser(db, (tx) =>
      tx.user.create({ data: { email: `u-${Math.random().toString(36).slice(2)}@playerz.test` } }),
    );
    const sessionSecret = newSessionSecret();
    const session = await createUserSession({
      userId: user.id,
      sessionSecret,
      expiresAt: new Date(Date.now() + 60_000),
    });
    return {
      userId: user.id,
      claims: {
        userSessionId: session.userSessionId,
        sessionVersion: session.sessionVersion,
        sessionSecret,
      },
    };
  }

  /** Delete the user — the session cascades — in the gap after the session select. */
  function deleteUserMidRead(userId: string) {
    afterSelectFrom('user_session', async () => {
      await asAppSuperuser(db, (tx: PrismaClient) => tx.user.delete({ where: { id: userId } }));
    });
  }

  afterEach(() => {
    // A test that asserts "survives the race" must also prove the race ran.
    expect(hookPending()).toBe(false);
  });

  it('the premise: Prisma returns `user: null` for the required relation', async () => {
    const { userId, claims } = await signedInUser();
    deleteUserMidRead(userId);

    const row = await asAppSuperuser(interleavingClient(), (tx) =>
      tx.userSession.findUnique({
        where: { id: claims.userSessionId },
        select: { id: true, user: { select: { sessionVersion: true } } },
      }),
    );

    // If this ever fails because Prisma throws or joins in one statement, the
    // guards below are still right; this test just stops proving the window.
    expect(row).toEqual({ id: claims.userSessionId, user: null });
  });

  it('checkSession: unusable, not a TypeError', async () => {
    const { userId, claims } = await signedInUser();
    deleteUserMidRead(userId);

    await expect(checkSession(claims)).resolves.toEqual({ usable: false, reason: 'unknown' });
  });

  it('requireSignedIn (the CI call site, /me/bookings): signed out, so the page redirects', async () => {
    const { userId, claims } = await signedInUser();
    mockToken.current = { sub: userId, ...claims };
    deleteUserMidRead(userId);

    await expect(requireSignedIn()).resolves.toBeNull();
  });

  it('rotateRefreshToken: "sign in again", not a TypeError', async () => {
    const { userId, claims } = await signedInUser();
    const refresh = newSessionSecret();
    await setRefreshToken(claims.userSessionId, refresh);
    deleteUserMidRead(userId);

    await expect(rotateRefreshToken({ presented: refresh })).resolves.toEqual({
      ok: false,
      reason: 'unknown',
    });
  });

  it('assertFreshStepUp: step-up required, not a TypeError', async () => {
    const { userId, claims } = await signedInUser();
    deleteUserMidRead(userId);

    await expect(
      asAppSuperuser(interleavingClient(), (tx) =>
        assertFreshStepUp(tx, { userId, userSessionId: claims.userSessionId }),
      ),
    ).rejects.toBeInstanceOf(PlatformStepUpRequiredError);
  });

  it('membershipContext: a club deleted mid-read is not-a-member, not a TypeError', async () => {
    const t = await seedTenant({}, db);
    afterSelectFrom('tenant_membership', async () => {
      await asAppSuperuser(db, (tx) => tx.venueOrg.delete({ where: { id: t.tenantId } }));
    });

    await expect(
      membershipContext(t.userId, t.tenantSlug, { groupGateCleared: [] }),
    ).resolves.toEqual({ kind: 'not-a-member' });
  });
});
