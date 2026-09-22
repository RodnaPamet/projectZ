import { getToken } from 'next-auth/jwt';

import { contextFromRequest } from '@/app/api/v1/_lib/context';

jest.mock('next-auth/jwt', () => ({ getToken: jest.fn() }));
const mockToken = getToken as unknown as jest.Mock;

const req = {} as never;
const BASE = { requestId: 'req_1' };

/** OWNER at club A (joined first), PLAYER at club B. */
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

beforeEach(() => mockToken.mockReset());

describe('contextFromRequest', () => {
  it('derives permissions from the membership matching the SLUG, not memberships[0]', async () => {
    // ═══ THE CROSS-TENANT ESCALATION ═══
    //
    // auth.ts freezes token.role/permissions to memberships[0] — whichever club
    // the player joined first. The edge middleware then checks those against the
    // slug in the URL, so an OWNER at club A carries admin.venue_manage to club
    // B, where they are only a PLAYER. Membership check passes (they ARE a
    // member of B); permission check passes (against A's role).
    mockToken.mockResolvedValue(twoClubs);

    const ctx = await contextFromRequest(req, { ...BASE, slug: 'club-b' });

    expect(ctx.tenantId).toBe('tnt_b');
    expect(ctx.role).toBe('PLAYER');
    expect(ctx.permissions).not.toContain('admin.venue_manage');
  });

  it('still grants the elevated role at the club it belongs to', async () => {
    // The other direction: re-deriving must not strip real authority.
    mockToken.mockResolvedValue(twoClubs);

    const ctx = await contextFromRequest(req, { ...BASE, slug: 'club-a' });

    expect(ctx.role).toBe('OWNER');
    expect(ctx.permissions).toContain('admin.venue_manage');
  });

  it('a slug the caller has NO membership for yields no tenant at all', async () => {
    mockToken.mockResolvedValue(twoClubs);

    const ctx = await contextFromRequest(req, { ...BASE, slug: 'someone-elses-club' });

    // Not club A as a fallback. Guessing a tenant is how you serve somebody
    // else's data to a client that forgot the slug.
    expect(ctx.tenantId).toBeNull();
    expect(ctx.role).toBeNull();
    expect(ctx.permissions).toEqual([]);
    expect(ctx.userId).toBe('usr_1'); // still authenticated
  });

  it('a signed-in request with NO slug is tenant-less, not tenant-guessed', async () => {
    // /me/** — notifications, account. Person-scoped, belongs to no club.
    mockToken.mockResolvedValue(twoClubs);

    const ctx = await contextFromRequest(req, { ...BASE, slug: null });

    expect(ctx.userId).toBe('usr_1');
    expect(ctx.tenantId).toBeNull();
    expect(ctx.tenantSlug).toBeNull();
  });

  it('anonymous is a first-class case, not an error', async () => {
    // Public venue search and guest booking have no token.
    mockToken.mockResolvedValue(null);

    const ctx = await contextFromRequest(req, { ...BASE, slug: 'club-a' });

    expect(ctx.userId).toBeNull();
    expect(ctx.tenantId).toBeNull();
    expect(ctx.permissions).toEqual([]);
  });

  it('carries the requestId and defaults locale to bg', async () => {
    mockToken.mockResolvedValue(null);

    const ctx = await contextFromRequest(req, { ...BASE, slug: null });

    expect(ctx.requestId).toBe('req_1');
    // The storefront is Bulgarian. An en default would silently serve the
    // wrong language to every client that omits the header.
    expect(ctx.locale).toBe('bg');
  });
});
