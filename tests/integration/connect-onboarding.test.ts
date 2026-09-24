import { NextRequest } from 'next/server';

import { POST as onboarding } from '@/app/api/v1/t/[slug]/connect/onboarding/route';

import { seedPlayer, signInAs, type TestIdentity } from '../helpers/auth';
import { prismaTestClient, seedTenant, type SeededTenant } from '../helpers/db';
import { findRequest, useMswServer } from '../helpers/msw';
import { asAppSuperuser } from '../helpers/rls';

/**
 * Stripe Connect onboarding — the piece without which the whole payment path
 * is unusable for real money.
 *
 * `createConnectedAccount` and `createOnboardingLink` have both existed,
 * correct and complete, with zero call sites, so no venue could ever obtain a
 * `stripeAccountId` and `checkoutBooking` threw PayoutsNotEnabledError for
 * everyone.
 */
describe('POST /api/v1/t/:slug/connect/onboarding', () => {
  useMswServer();

  const db = prismaTestClient();

  let tenant: SeededTenant;
  let owner: TestIdentity;
  let player: TestIdentity;

  beforeEach(async () => {
    process.env.NEXTAUTH_URL = 'https://playerz.test';
    tenant = await seedTenant({});

    owner = await signInAs(db, {
      userId: tenant.userId,
      memberships: [{ tenantId: tenant.tenantId, tenantSlug: tenant.tenantSlug, role: 'OWNER' }],
    });

    const playerId = await seedPlayer(db, tenant.tenantId);
    player = await signInAs(db, {
      userId: playerId,
      memberships: [{ tenantId: tenant.tenantId, tenantSlug: tenant.tenantSlug, role: 'PLAYER' }],
    });
  });

  const call = async (who: TestIdentity) => {
    const res = await onboarding(
      new NextRequest(`http://t/api/v1/t/${tenant.tenantSlug}/connect/onboarding`, {
        method: 'POST',
        headers: { authorization: `Bearer ${who.bearer}`, 'content-type': 'application/json' },
      }),
      { params: Promise.resolve({ slug: tenant.tenantSlug }) },
    );
    return { res, body: (await res.json()) as never };
  };

  const venueRow = () =>
    asAppSuperuser(db, (tx) => tx.venueOrg.findUniqueOrThrow({ where: { id: tenant.tenantId } }));

  type Body = {
    data: {
      stripeAccountId: string;
      onboardingUrl: string;
      payoutsEnabled: boolean;
      created: boolean;
    };
  };

  it('creates the Stripe account and returns an onboarding link', async () => {
    const { res, body } = await call(owner);
    const d = (body as Body).data;

    expect(res.status).toBe(200);
    expect(d.stripeAccountId).toMatch(/^acct_/);
    expect(d.onboardingUrl).toContain('connect.stripe.com');
    expect(d.created).toBe(true);

    // Stored, or the next call creates a second account.
    expect((await venueRow()).stripeAccountId).toBe(d.stripeAccountId);
  });

  it('does NOT mark payouts enabled — only the webhook may do that', async () => {
    // Finishing Stripe's form is not the same as Stripe accepting the club's
    // documents. Setting this optimistically would let a club take bookings
    // whose money can never be paid out.
    const { body } = await call(owner);

    expect((body as Body).data.payoutsEnabled).toBe(false);
    expect((await venueRow()).payoutsEnabled).toBe(false);
  });

  it('audits the account creation against the admin who did it', async () => {
    await call(owner);

    const audit = await asAppSuperuser(db, (tx) =>
      tx.auditEntry.findMany({ where: { tenantId: tenant.tenantId } }),
    );

    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      action: 'CONNECT_ACCOUNT_CREATED',
      actorUserId: tenant.userId,
      entity: 'VenueOrg',
    });
  });

  it('REUSES the account on a second call and mints a fresh link', async () => {
    // Stripe's onboarding links expire, so an admin returning to a
    // half-finished setup needs a new link — but not a new account.
    const first = await call(owner);
    const second = await call(owner);

    expect((first.body as Body).data.stripeAccountId).toBe(
      (second.body as Body).data.stripeAccountId,
    );
    expect((second.body as Body).data.created).toBe(false);
    expect((second.body as Body).data.onboardingUrl).toContain('connect.stripe.com');
  });

  it('sends an idempotency key, so two simultaneous clicks cannot orphan an account', async () => {
    // A database transaction can roll back our row. It cannot un-create an
    // Express account sitting half-onboarded in the club's Stripe dashboard
    // that nothing here knows about.
    await call(owner);

    const req = findRequest('/v1/accounts');
    expect(req).toBeTruthy();
    expect(req!.headers['idempotency-key']).toBe(`connect:account:${tenant.tenantId}`);
  });

  it('builds the return URLs server-side, never from the request', async () => {
    // A caller-supplied returnUrl is an open redirect with extra steps: Stripe
    // would send the club's admin wherever the body said, on a page that looks
    // like the last step of our own flow.
    await call(owner);

    const req = findRequest('/v1/account_links');
    const body = req!.body as Record<string, string>;
    expect(body.return_url).toContain('https://playerz.test');
    expect(body.refresh_url).toContain('https://playerz.test');
  });

  it('403s for a PLAYER — this is where the club’s money lands', async () => {
    const { res } = await call(player);
    expect(res.status).toBe(403);
  });

  it('401s without a token', async () => {
    const res = await onboarding(
      new NextRequest(`http://t/api/v1/t/${tenant.tenantSlug}/connect/onboarding`, {
        method: 'POST',
      }),
      { params: Promise.resolve({ slug: tenant.tenantSlug }) },
    );

    expect(res.status).toBe(401);
  });
});
