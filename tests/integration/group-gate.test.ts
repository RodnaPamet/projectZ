import type { Prisma } from '@prisma/client';
import type { JWT } from 'next-auth/jwt';
import { NextRequest } from 'next/server';

import { authOptions } from '@/auth';
import { POST as signInNative } from '@/app/api/v1/auth/token/route';
import { GET as listBookings, POST as createBooking } from '@/app/api/v1/t/[slug]/bookings/route';
import { GET as me } from '@/app/api/v1/t/[slug]/me/route';
import type { EntraGroupClaims } from '@/lib/auth/entra-group-claims';
import { membershipContext } from '@/lib/auth/page-context';
import { hashPassword } from '@/lib/auth/passwords';
import { middleware } from '@/middleware';

import { signInAs } from '../helpers/auth';
import { prismaTestClient, seedTenant, type SeededTenant } from '../helpers/db';
import { asAppSuperuser } from '../helpers/rls';

/**
 * THE ENTRA GROUP GATE SURVIVES #250.
 *
 * ═══ WHAT WOULD HAVE BROKEN ═══
 *
 * `enforceGroupGate` refuses a club to any session that cannot prove, through
 * an Entra sign-in, that the person is in one of the club's mapped directory
 * groups. Before #250 its only enforcement was an ABSENCE: `src/auth.ts`
 * dropped the club from `token.memberships`, and the edge answered 403 to a
 * slug the token did not list. The membership row was left alone, on purpose.
 *
 * #250 makes the edge defer every unlisted slug to the database — which says
 * "member", because the row is untouched. Moving the gate was therefore not
 * optional: without `@/lib/auth/group-gate`, every gated club would have
 * opened to every session the gate had refused, the moment this merged.
 *
 * These tests pin the gate end to end: what the Entra sign-in records, what a
 * request is then allowed, through the real middleware and routes and the
 * resolver the pages use — and that an allow-list, not a deny-list, is what
 * travels, so a session that evaluated nothing (a native sign-in, a club joined
 * later) is refused rather than waved through.
 */

const claimsFor = jest.fn<Promise<EntraGroupClaims>, []>();

// Microsoft's group list, which only exists for the length of an Entra
// callback. Everything downstream of it — the sync, the mappings, the gate,
// the token — is real.
jest.mock('@/lib/auth/entra-group-claims', () => ({
  resolveEntraGroupClaims: () => claimsFor(),
}));

const db = prismaTestClient();
const PASSWORD = 'correct horse battery staple';

const DIRECTORY = '11111111-1111-4111-8111-111111111111';
const GROUP_STAFF = '0f8fad5b-d9cb-469f-a165-70867728950e';

const inGroups = (groups: string[]): EntraGroupClaims => ({
  groups,
  source: 'token',
  overage: false,
  complete: true,
  directoryTenantId: DIRECTORY,
});

let gated: SeededTenant;
let staff: { id: string; email: string };
let ipCounter = 0;

async function newUser(
  label: string,
  accountKind: 'PLAYER' | 'CLUB' = 'PLAYER',
): Promise<{ id: string; email: string }> {
  const email = `${label}-${Math.random().toString(36).slice(2, 10)}@playerz.test`;
  const passwordHash = await hashPassword(PASSWORD);
  const u = await asAppSuperuser(db, (tx) =>
    tx.user.create({
      data: { email, name: label, passwordHash, accountKind },
      select: { id: true },
    }),
  );
  return { id: u.id, email };
}

async function gate(
  t: SeededTenant,
  opts: { enforce: boolean; enabled?: boolean; configJson?: Prisma.InputJsonObject },
) {
  const configJson = opts.configJson ?? {
    aadTenantId: DIRECTORY,
    clientId: '22222222-2222-4222-8222-222222222222',
    enforceGroupGate: opts.enforce,
  };
  await asAppSuperuser(db, (tx) =>
    tx.tenantIdentityProvider.upsert({
      where: { tenantId_type: { tenantId: t.tenantId, type: 'ENTRA_ID' } },
      create: { tenantId: t.tenantId, type: 'ENTRA_ID', enabled: opts.enabled ?? true, configJson },
      update: { enabled: opts.enabled ?? true, configJson },
    }),
  );
}

beforeEach(async () => {
  claimsFor.mockReset();

  gated = await seedTenant({ name: 'Gated Club' });
  await gate(gated, { enforce: true });
  await asAppSuperuser(db, (tx) =>
    tx.tenantEntraGroupMapping.create({
      data: { tenantId: gated.tenantId, aadGroupId: GROUP_STAFF, role: 'STAFF', priority: 0 },
    }),
  );

  // Staff are a CLUB account (#263); the database refuses STAFF on any other kind.
  staff = await newUser('staff', 'CLUB');
  await asAppSuperuser(db, (tx) =>
    tx.tenantMembership.create({
      data: { userId: staff.id, tenantId: gated.tenantId, role: 'STAFF', status: 'ACTIVE' },
    }),
  );
});

/** The jwt callback, exactly as next-auth calls it on a sign-in. */
async function signInThrough(provider: 'azure-ad' | 'google', userId: string): Promise<JWT> {
  const jwt = authOptions.callbacks!.jwt! as unknown as (args: {
    token: JWT;
    user: { id: string };
    account: { provider: string; type: string; access_token?: string };
    profile?: Record<string, unknown>;
  }) => Promise<JWT>;

  return jwt({
    token: {},
    user: { id: userId },
    account: { provider, type: 'oauth', access_token: 'at' },
    profile: {},
  });
}

/** Through the middleware, then the route — see tenant-gate.test.ts for why. */
async function send(
  handler: (req: NextRequest, ctx: { params: Promise<{ slug: string }> }) => Promise<Response>,
  method: string,
  path: string,
  slug: string,
  headers: Record<string, string>,
  body?: unknown,
): Promise<{ status: number; by: 'edge' | 'route'; body: unknown }> {
  const init = () => ({
    method,
    headers: {
      ...headers,
      ...(body === undefined
        ? {}
        : { 'content-type': 'application/json', 'idempotency-key': `k-${Math.random()}` }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const url = `http://localhost:3000${path}`;

  const edge = await middleware(new NextRequest(url, init()));
  if (edge.headers.get('x-middleware-next') !== '1') {
    return { status: edge.status, by: 'edge', body: await edge.json().catch(() => null) };
  }
  const res = await handler(new NextRequest(url, init()), { params: Promise.resolve({ slug }) });
  return { status: res.status, by: 'route', body: await res.json().catch(() => null) };
}

async function native(email: string): Promise<Record<string, string>> {
  const res = await signInNative(
    new NextRequest('http://localhost:3000/api/v1/auth/token', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-forwarded-for': `10.251.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}`,
      },
      body: JSON.stringify({ email, password: PASSWORD }),
    }),
    undefined,
  );
  expect(res.status).toBe(200);
  const { accessToken } = ((await res.json()) as { data: { accessToken: string } }).data;
  return { authorization: `Bearer ${accessToken}` };
}

async function web(
  userId: string,
  claims: Record<string, unknown>,
): Promise<Record<string, string>> {
  const { bearer } = await signInAs(db, { userId, memberships: [], claims });
  return {
    cookie: `next-auth.session-token=${bearer}; __Secure-next-auth.session-token=${bearer}`,
  };
}

const mePath = (t: SeededTenant) => `/api/v1/t/${t.tenantSlug}/me`;

describe('what an Entra sign-in records', () => {
  it('clears the gate at a club whose mapped group the person is in', async () => {
    claimsFor.mockResolvedValue(inGroups([GROUP_STAFF]));

    const token = await signInThrough('azure-ad', staff.id);

    expect(token.groupGateCleared).toEqual([gated.tenantId]);
    expect(token.memberships?.map((m) => m.tenantSlug)).toEqual([gated.tenantSlug]);
  });

  it('clears NOTHING at a club whose gate refused them — and drops the claim as before', async () => {
    claimsFor.mockResolvedValue(inGroups(['some-other-group']));

    const token = await signInThrough('azure-ad', staff.id);

    expect(token.groupGateCleared).toEqual([]);
    expect(token.memberships).toEqual([]);
  });

  it('a Google sign-in records no clearance — it cannot prove a directory group', async () => {
    const token = await signInThrough('google', staff.id);

    expect(token.groupGateCleared).toBeUndefined();
    expect(claimsFor).not.toHaveBeenCalled();
  });

  it('an Entra sync that FAILS signs in "with existing roles", exactly as before #250', async () => {
    // The documented failure mode of that block: a Graph outage must not become
    // a lockout. Before #250 that meant every club stayed in the claim list, and
    // the list was the access. The clearance mirrors it, rather than quietly
    // changing what an outage does to a gated club.
    claimsFor.mockRejectedValue(new Error('graph.microsoft.com is having a day'));

    const token = await signInThrough('azure-ad', staff.id);

    expect(token.groupGateCleared).toEqual([gated.tenantId]);
  });
});

describe('what a request is then allowed, through the middleware', () => {
  it('a session that passed the gate reaches the club', async () => {
    claimsFor.mockResolvedValue(inGroups([GROUP_STAFF]));
    const token = await signInThrough('azure-ad', staff.id);

    const who = await send(
      me,
      'GET',
      mePath(gated),
      gated.tenantSlug,
      await web(staff.id, { groupGateCleared: token.groupGateCleared }),
    );

    expect(who).toMatchObject({ status: 200, by: 'route' });
  });

  it('THE REGRESSION #250 WOULD HAVE BEEN: a refused session is refused, although the row is there', async () => {
    // The edge lets it through now — the token does not list the club, so it
    // defers — and the database says "STAFF". The gate is what says no.
    claimsFor.mockResolvedValue(inGroups(['some-other-group']));
    const token = await signInThrough('azure-ad', staff.id);
    const refused = await web(staff.id, { groupGateCleared: token.groupGateCleared });

    const who = await send(me, 'GET', mePath(gated), gated.tenantSlug, refused);
    const listed = await send(
      listBookings,
      'GET',
      `/api/v1/t/${gated.tenantSlug}/bookings`,
      gated.tenantSlug,
      refused,
    );

    expect(who).toMatchObject({ status: 404, by: 'route' });
    expect(listed).toMatchObject({ status: 200, by: 'route' });
    expect((listed.body as { data: { items: unknown[] } }).data.items).toEqual([]);
  });

  it('a NATIVE sign-in, which evaluates nothing, is refused at a gated club', async () => {
    // A deny-list would have waved this through: nothing was ever denied,
    // because nothing was ever evaluated.
    const who = await send(me, 'GET', mePath(gated), gated.tenantSlug, await native(staff.email));

    expect(who).toMatchObject({ status: 404, by: 'route' });
  });

  it('the OWNER is never gated — somebody must be able to get in and fix it', async () => {
    const owner = await asAppSuperuser(db, (tx) =>
      tx.user.findUniqueOrThrow({ where: { id: gated.userId }, select: { email: true } }),
    );
    await asAppSuperuser(db, async (tx) =>
      tx.user.update({
        where: { id: gated.userId },
        data: { passwordHash: await hashPassword(PASSWORD) },
      }),
    );

    const who = await send(me, 'GET', mePath(gated), gated.tenantSlug, await native(owner.email));

    expect(who).toMatchObject({ status: 200, by: 'route' });
  });

  it('with the gate OFF, or the provider disabled, nobody needs clearance', async () => {
    await gate(gated, { enforce: false });
    expect(
      await send(me, 'GET', mePath(gated), gated.tenantSlug, await native(staff.email)),
    ).toMatchObject({ status: 200 });

    await gate(gated, { enforce: true, enabled: false });
    expect(
      await send(me, 'GET', mePath(gated), gated.tenantSlug, await native(staff.email)),
    ).toMatchObject({ status: 200 });
  });

  it('a corrupt provider config does not switch the gate off', async () => {
    // The flag is read off the raw JSON by `readGroupGateFlag`; an invalid
    // `aadTenantId` must not be the way a restriction stops applying.
    await gate(gated, {
      enforce: true,
      configJson: { aadTenantId: 'nope', enforceGroupGate: true },
    });

    const who = await send(me, 'GET', mePath(gated), gated.tenantSlug, await native(staff.email));

    expect(who).toMatchObject({ status: 404, by: 'route' });
  });

  it('a gated club cannot be JOINED by booking one of its courts', async () => {
    // Joining works for the first time since #250. A closed club must stay
    // closed: a stranger enrolling by booking would be refused on every request
    // after the one that enrolled them.
    const stranger = await newUser('stranger');

    const booked = await send(
      createBooking,
      'POST',
      `/api/v1/t/${gated.tenantSlug}/bookings`,
      gated.tenantSlug,
      await native(stranger.email),
      { resourceId: 'any', startTs: '2036-07-16T06:00:00Z', endTs: '2036-07-16T07:00:00Z' },
    );

    expect(booked).toMatchObject({ status: 404, by: 'route' });
    expect(
      await asAppSuperuser(db, (tx) =>
        tx.tenantMembership.findUnique({
          where: { userId_tenantId: { userId: stranger.id, tenantId: gated.tenantId } },
        }),
      ),
    ).toBeNull();
  });
});

describe('the pages ask the same question', () => {
  it('resolveTenantPageContext refuses an uncleared session and admits a cleared one', async () => {
    // Admin pages and every Server Action resolve through membershipContext.
    // Before #250 the edge kept a gated session off /t/{slug}/** entirely.
    expect(
      (await membershipContext(staff.id, gated.tenantSlug, { groupGateCleared: [] })).kind,
    ).toBe('not-a-member');
    expect(
      (await membershipContext(staff.id, gated.tenantSlug, { groupGateCleared: [gated.tenantId] }))
        .kind,
    ).toBe('ok');
  });

  it('a clearance for ANOTHER club clears nothing here', async () => {
    const other = await seedTenant({ name: 'Other' });

    expect(
      (await membershipContext(staff.id, gated.tenantSlug, { groupGateCleared: [other.tenantId] }))
        .kind,
    ).toBe('not-a-member');
  });
});
