import { getToken } from 'next-auth/jwt';

import { contextFromRequest } from '@/app/api/v1/_lib/context';
import { membershipContext } from '@/lib/auth/page-context';

jest.mock('next-auth/jwt', () => ({ getToken: jest.fn() }));

// `contextFromRequest` now verifies the session, which reaches Prisma and
// therefore `pg` — a Node-only chain that does not load under jsdom. These
// tests are about PERMISSION DERIVATION, so the session check is stubbed
// usable; tests/unit/api-v1/context-revocation.test.ts covers the other half.
jest.mock('@/lib/auth/sessions', () => ({
  checkSession: jest.fn(async () => ({ usable: true })),
}));

// Since #250 the membership comes from the database, through the resolver the
// pages use. Stubbed here so each test can say what the DATABASE holds, which
// is now the only thing that decides; tests/integration/tenant-gate.test.ts
// runs the real one, through the real middleware.
jest.mock('@/lib/auth/page-context', () => ({ membershipContext: jest.fn() }));

const mockToken = getToken as unknown as jest.Mock;
const mockMembership = membershipContext as unknown as jest.Mock;

const BASE = { requestId: 'req_1' };

/** A request as a route handler receives it: the path and verb are what the table keys on. */
const request = (path: string, method = 'GET') =>
  ({
    nextUrl: new URL(`https://playerz.bg${path}`),
    method,
    // A native caller: no Sec-Fetch-Site, no viewer header, no session cookie.
    // context-guards.test.ts covers what a browser sends.
    headers: { get: () => null },
    cookies: { getAll: () => [] },
  }) as never;

/** OWNER at club A (joined first), PLAYER at club B — according to the TOKEN. */
const twoClubs = {
  sub: 'usr_1',
  // Present and WRONG on purpose: auth.ts mints these from memberships[0].
  // Nothing in contextFromRequest may read them.
  tenantId: 'tnt_a',
  tenantSlug: 'club-a',
  role: 'OWNER',
  permissions: ['admin.venue_manage'],
  memberships: [
    { tenantId: 'tnt_a', tenantSlug: 'club-a', role: 'OWNER' },
    { tenantId: 'tnt_b', tenantSlug: 'club-b', role: 'PLAYER' },
  ],
  membershipsTruncated: false,
};

/** What a native access token carries: identity and session, no clubs at all. */
const nativeToken = { sub: 'usr_1', userSessionId: 'ses_1', sessionVersion: 0 };

const holds = (role: string, tenantId: string, tenantSlug: string, permissions: string[]) =>
  mockMembership.mockResolvedValue({
    kind: 'ok',
    ctx: { userId: 'usr_1', tenantId, tenantSlug, role, permissions },
  });

const holdsNothing = () => mockMembership.mockResolvedValue({ kind: 'not-a-member' });

beforeEach(() => {
  mockToken.mockReset();
  mockMembership.mockReset();
});

describe('contextFromRequest', () => {
  it('derives permissions from the membership the DATABASE holds at the slug', async () => {
    // ═══ THE CROSS-TENANT ESCALATION ═══
    //
    // auth.ts freezes token.role/permissions to memberships[0] — whichever club
    // the player joined first. An OWNER at club A would otherwise carry
    // admin.venue_manage to club B, where they are only a PLAYER.
    mockToken.mockResolvedValue(twoClubs);
    holds('PLAYER', 'tnt_b', 'club-b', ['bookings.create', 'bookings.cancel']);

    const ctx = await contextFromRequest(request('/api/v1/t/club-b/me'), {
      ...BASE,
      slug: 'club-b',
    });

    expect(mockMembership).toHaveBeenCalledWith('usr_1', 'club-b');
    expect(ctx.tenantId).toBe('tnt_b');
    expect(ctx.role).toBe('PLAYER');
    expect(ctx.permissions).not.toContain('admin.venue_manage');
  });

  it("ignores the token's OWN claim for the slug when the database disagrees (#250)", async () => {
    // A web token lists its clubs for up to seven days. Demoted since, it still
    // says OWNER — and this used to believe it.
    mockToken.mockResolvedValue(twoClubs);
    holds('STAFF', 'tnt_a', 'club-a', ['bookings.view_all']);

    const ctx = await contextFromRequest(request('/api/v1/t/club-a/me'), {
      ...BASE,
      slug: 'club-a',
    });

    expect(ctx.role).toBe('STAFF');
    expect(ctx.permissions).toEqual(['bookings.view_all']);
  });

  it('resolves a NATIVE token, which lists no clubs, at a club it belongs to (#250)', async () => {
    // The whole issue in one assertion: a token with no `memberships` claim
    // used to produce no tenant — and never reached here anyway, because the
    // edge refused it first.
    mockToken.mockResolvedValue(nativeToken);
    holds('PLAYER', 'tnt_b', 'club-b', ['bookings.create']);

    const ctx = await contextFromRequest(request('/api/v1/t/club-b/bookings', 'POST'), {
      ...BASE,
      slug: 'club-b',
    });

    expect(ctx.tenantId).toBe('tnt_b');
    expect(ctx.permissions).toContain('bookings.create');
  });

  it('a READ at a club the caller has no membership for yields no tenant at all', async () => {
    mockToken.mockResolvedValue(twoClubs);
    holdsNothing();

    const ctx = await contextFromRequest(request('/api/v1/t/someone-elses-club/me'), {
      ...BASE,
      slug: 'someone-elses-club',
    });

    // Not club A as a fallback. Guessing a tenant is how you serve somebody
    // else's data to a client that forgot the slug.
    expect(ctx.tenantId).toBeNull();
    expect(ctx.role).toBeNull();
    expect(ctx.permissions).toEqual([]);
    expect(ctx.userId).toBe('usr_1'); // still authenticated
  });

  describe('the permission table, enforced against the database', () => {
    it('refuses a MUTATION at a club the caller does not belong to — opaquely', async () => {
      // The edge lets this through undecided now. Nothing about that may make
      // it allowed: the refusal happens here, before the handler runs, with
      // the body the edge used to send.
      mockToken.mockResolvedValue(nativeToken);
      holdsNothing();

      const attempt = contextFromRequest(request('/api/v1/t/club-z/bookings/b1/cancel', 'POST'), {
        ...BASE,
        slug: 'club-z',
      });

      await expect(attempt).rejects.toMatchObject({
        status: 403,
        code: 'FORBIDDEN',
        message: 'Forbidden',
      });
      // No `details`: naming the permission would say the path exists for a
      // member, and the answer must be the same for a club that does not.
      await expect(attempt).rejects.not.toHaveProperty('details.requiredPermission');
    });

    it('refuses a member whose role HERE lacks the permission, and names it', async () => {
      // A PLAYER posting to the payouts route. The edge could not have caught
      // it for a native token, which carries no role to read.
      mockToken.mockResolvedValue(nativeToken);
      holds('PLAYER', 'tnt_b', 'club-b', ['bookings.create', 'bookings.cancel']);

      await expect(
        contextFromRequest(request('/api/v1/t/club-b/connect/onboarding', 'POST'), {
          ...BASE,
          slug: 'club-b',
        }),
      ).rejects.toMatchObject({
        status: 403,
        code: 'FORBIDDEN',
        details: { requiredPermission: 'admin.billing_manage' },
      });
    });

    it('checks the role the database holds, not the one the token claims', async () => {
      // Token: OWNER at club-a. Database: demoted to PLAYER. The mutation is
      // refused although every claim in the token says yes.
      mockToken.mockResolvedValue(twoClubs);
      holds('PLAYER', 'tnt_a', 'club-a', ['bookings.create']);

      await expect(
        contextFromRequest(request('/api/v1/t/club-a/connect/onboarding', 'POST'), {
          ...BASE,
          slug: 'club-a',
        }),
      ).rejects.toMatchObject({ status: 403 });
    });

    it('lets through a member whose role holds it', async () => {
      mockToken.mockResolvedValue(nativeToken);
      holds('OWNER', 'tnt_b', 'club-b', ['admin.billing_manage']);

      const ctx = await contextFromRequest(request('/api/v1/t/club-b/connect/onboarding', 'POST'), {
        ...BASE,
        slug: 'club-b',
      });

      expect(ctx.tenantId).toBe('tnt_b');
    });

    it('admits a non-member to the JOIN route only, with no tenant and no permissions', async () => {
      // `POST /bookings` is how a player joins a club (#229). The context
      // admits them and grants nothing; the route creates the membership.
      mockToken.mockResolvedValue(nativeToken);
      holdsNothing();

      const ctx = await contextFromRequest(request('/api/v1/t/club-z/bookings', 'POST'), {
        ...BASE,
        slug: 'club-z',
        joinsAsPlayer: true,
      });

      expect(ctx.userId).toBe('usr_1');
      expect(ctx.tenantId).toBeNull();
      expect(ctx.permissions).toEqual([]);
    });

    it('the same POST WITHOUT the flag is refused — the flag, not the path, admits', async () => {
      mockToken.mockResolvedValue(nativeToken);
      holdsNothing();

      await expect(
        contextFromRequest(request('/api/v1/t/club-z/bookings', 'POST'), {
          ...BASE,
          slug: 'club-z',
        }),
      ).rejects.toMatchObject({ status: 403 });
    });

    it('the join flag does not excuse a MEMBER from the table', async () => {
      // A member is checked like everywhere else. Every role holds
      // `bookings.create` today, so this uses a permission set without it to
      // prove the check runs rather than that it happens to pass.
      mockToken.mockResolvedValue(nativeToken);
      holds('PLAYER', 'tnt_b', 'club-b', []);

      await expect(
        contextFromRequest(request('/api/v1/t/club-b/bookings', 'POST'), {
          ...BASE,
          slug: 'club-b',
          joinsAsPlayer: true,
        }),
      ).rejects.toMatchObject({
        status: 403,
        details: { requiredPermission: 'bookings.create' },
      });
    });

    it('an ANONYMOUS caller on a route that needs a permission is a 401, not an anonymous context', async () => {
      mockToken.mockResolvedValue(null);

      await expect(
        contextFromRequest(request('/api/v1/t/club-b/bookings', 'POST'), {
          ...BASE,
          slug: 'club-b',
        }),
      ).rejects.toMatchObject({ status: 401, code: 'UNAUTHORIZED' });
      expect(mockMembership).not.toHaveBeenCalled();
    });

    it('a route that needs a permission and names no club is refused, not guessed', async () => {
      mockToken.mockResolvedValue(twoClubs);

      await expect(
        contextFromRequest(request('/api/v1/t/club-a/bookings', 'POST'), { ...BASE, slug: null }),
      ).rejects.toMatchObject({ status: 403 });
      expect(mockMembership).not.toHaveBeenCalled();
    });
  });

  it('a signed-in request with NO slug is tenant-less, not tenant-guessed', async () => {
    // /me/** — notifications, account. Person-scoped, belongs to no club.
    mockToken.mockResolvedValue(twoClubs);

    const ctx = await contextFromRequest(request('/api/v1/devices'), { ...BASE, slug: null });

    expect(ctx.userId).toBe('usr_1');
    expect(ctx.tenantId).toBeNull();
    expect(ctx.tenantSlug).toBeNull();
    expect(mockMembership).not.toHaveBeenCalled();
  });

  it('anonymous is a first-class case, not an error', async () => {
    // Public venue search and guest booking have no token.
    mockToken.mockResolvedValue(null);

    const ctx = await contextFromRequest(request('/api/v1/t/club-a/me'), {
      ...BASE,
      slug: 'club-a',
    });

    expect(ctx.userId).toBeNull();
    expect(ctx.tenantId).toBeNull();
    expect(ctx.permissions).toEqual([]);
  });

  it('carries the requestId and defaults locale to bg', async () => {
    mockToken.mockResolvedValue(null);

    const ctx = await contextFromRequest(request('/api/v1/venues'), { ...BASE, slug: null });

    expect(ctx.requestId).toBe('req_1');
    // The storefront is Bulgarian. An en default would silently serve the
    // wrong language to every client that omits the header.
    expect(ctx.locale).toBe('bg');
  });
});
