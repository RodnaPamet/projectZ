import { encode } from 'next-auth/jwt';
import { NextRequest } from 'next/server';

import { GET as me } from '@/app/api/v1/t/[slug]/me/route';
import { createUserSession, newSessionSecret } from '@/lib/auth/sessions';

import { prismaTestClient, seedTenant } from '../helpers/db';
import { asAppSuperuser } from '../helpers/rls';

/**
 * GET /api/v1/t/{slug}/me — the first authenticated, tenant-scoped route.
 *
 * It exists to prove the whole native chain on a surface where being wrong
 * cannot write anything:
 *
 *   Bearer <jwe> -> getToken -> checkTenantAccess -> contextFromRequest -> answer
 */
describe('GET /api/v1/t/{slug}/me', () => {
  const db = prismaTestClient();

  /** Mint a Bearer token the way /auth/token does. */
  async function bearerFor(userId: string) {
    const { userSessionId, sessionVersion } = await createUserSession({
      userId,
      sessionSecret: newSessionSecret(),
      expiresAt: new Date(Date.now() + 3600_000),
    });

    return encode({
      secret: process.env.NEXTAUTH_SECRET!,
      maxAge: 900,
      token: { sub: userId, userSessionId, sessionVersion },
    });
  }

  const get = (slug: string, bearer?: string) =>
    me(
      new NextRequest(`http://t/api/v1/t/${slug}/me`, {
        headers: bearer ? { authorization: `Bearer ${bearer}` } : {},
      }),
      { params: Promise.resolve({ slug }) },
    );

  it('THE POINT: a Bearer token resolves to who you are at this club', async () => {
    const t = await seedTenant({}, db);
    const slug = (
      await asAppSuperuser(db, (tx) =>
        tx.venueOrg.findUniqueOrThrow({ where: { id: t.tenantId }, select: { slug: true } }),
      )
    ).slug;

    const res = await get(slug, await bearerFor(t.userId));
    expect(res.status).toBe(200);

    const { data } = (await res.json()) as {
      data: {
        user: { id: string };
        tenant: { id: string; slug: string };
        membership: { role: string; permissions: string[] };
      };
    };

    expect(data.user.id).toBe(t.userId);
    expect(data.tenant.id).toBe(t.tenantId);
    expect(data.tenant.slug).toBe(slug);
    expect(data.membership.permissions.length).toBeGreaterThan(0);
  });

  it('401s without a token', async () => {
    const t = await seedTenant({}, db);
    const slug = (
      await asAppSuperuser(db, (tx) =>
        tx.venueOrg.findUniqueOrThrow({ where: { id: t.tenantId }, select: { slug: true } }),
      )
    ).slug;

    expect((await get(slug)).status).toBe(401);
  });

  it('404s for a club you do not belong to — and for one that does not exist', async () => {
    // These must be INDISTINGUISHABLE, or the endpoint is a tenant-enumeration
    // oracle. Same reasoning checkTenantAccess uses when it refuses to
    // separate "no such tenant" from "not a member of it".
    const mine = await seedTenant({}, db);
    const theirs = await seedTenant({}, db);
    const theirSlug = (
      await asAppSuperuser(db, (tx) =>
        tx.venueOrg.findUniqueOrThrow({ where: { id: theirs.tenantId }, select: { slug: true } }),
      )
    ).slug;

    const bearer = await bearerFor(mine.userId);

    const notAMember = await get(theirSlug, bearer);
    const noSuchClub = await get('no-such-club-anywhere', bearer);

    expect(notAMember.status).toBe(404);
    expect(noSuchClub.status).toBe(404);
    expect(await notAMember.json()).toEqual(await noSuchClub.json());
  });

  it('reports permissions for THIS club, not the first one joined', async () => {
    // ═══ THE CROSS-TENANT ESCALATION, ON A READ-ONLY SURFACE ═══
    //
    // auth.ts freezes token.role/permissions to memberships[0] — whichever club
    // was joined first. An OWNER at A who is a PLAYER at B would otherwise be
    // reported as an OWNER at B.
    const a = await seedTenant({}, db);
    const b = await seedTenant({}, db);

    const bSlug = await asAppSuperuser(db, async (tx) => {
      await tx.tenantMembership.updateMany({
        where: { userId: a.userId, tenantId: a.tenantId },
        data: { role: 'OWNER' },
      });
      // Same person, PLAYER at the second club.
      await tx.tenantMembership.create({
        data: { userId: a.userId, tenantId: b.tenantId, role: 'PLAYER', status: 'ACTIVE' },
      });
      const org = await tx.venueOrg.findUniqueOrThrow({
        where: { id: b.tenantId },
        select: { slug: true },
      });
      return org.slug;
    });

    const res = await get(bSlug, await bearerFor(a.userId));
    const { data } = (await res.json()) as {
      data: { membership: { role: string; permissions: string[] } };
    };

    expect(data.membership.role).toBe('PLAYER');
    expect(data.membership.permissions).not.toContain('admin.venue_manage');
  });

  it('answers AUTHORITATIVELY for a club joined after the token was minted', async () => {
    // A native access token lives 15 minutes and its refresh token 30 days,
    // and nothing re-mints the claims in between. Answering from the token
    // would tell a player who just joined a club that they are not a member —
    // from the one endpoint they would ask.
    const t = await seedTenant({}, db);
    const later = await seedTenant({}, db);

    const bearer = await bearerFor(t.userId); // minted BEFORE the join below

    const laterSlug = await asAppSuperuser(db, async (tx) => {
      await tx.tenantMembership.create({
        data: { userId: t.userId, tenantId: later.tenantId, role: 'STAFF', status: 'ACTIVE' },
      });
      const org = await tx.venueOrg.findUniqueOrThrow({
        where: { id: later.tenantId },
        select: { slug: true },
      });
      return org.slug;
    });

    const res = await get(laterSlug, bearer);
    expect(res.status).toBe(200);

    const { data } = (await res.json()) as {
      data: { membership: { role: string }; tokenStale: boolean };
    };

    expect(data.membership.role).toBe('STAFF');
    // And it SAYS the token is behind, which is the signal to refresh — the
    // edge authorises mutations from claims alone and never asks the database.
    expect(data.tokenStale).toBe(true);
  });

  it('a revoked session is refused even with a structurally valid token', async () => {
    const t = await seedTenant({}, db);
    const slug = (
      await asAppSuperuser(db, (tx) =>
        tx.venueOrg.findUniqueOrThrow({ where: { id: t.tenantId }, select: { slug: true } }),
      )
    ).slug;

    const bearer = await bearerFor(t.userId);
    expect((await get(slug, bearer)).status).toBe(200);

    await asAppSuperuser(db, (tx) =>
      tx.userSession.updateMany({ where: { userId: t.userId }, data: { revokedAt: new Date() } }),
    );

    expect((await get(slug, bearer)).status).toBe(401);
  });

  it("does not leak the club's internal fields", async () => {
    const t = await seedTenant({}, db);
    const slug = (
      await asAppSuperuser(db, (tx) =>
        tx.venueOrg.findUniqueOrThrow({ where: { id: t.tenantId }, select: { slug: true } }),
      )
    ).slug;

    const raw = JSON.stringify(await (await get(slug, await bearerFor(t.userId))).json());
    expect(raw).not.toContain('contactEmail');
    expect(raw).not.toContain('stripeAccountId');
  });
});
