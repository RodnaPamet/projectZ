import type { PrismaClient } from '@prisma/client';

import { startConnectOnboarding } from '@/app-layer/usecases/connect-onboarding';
import { handleSubscriptionUpserted } from '@/lib/billing/webhook-handlers';

import { prismaTestClient, seedTenant, type SeededTenant } from '../helpers/db';
import { findRequest, recorded, useMswServer } from '../helpers/msw';
import { asAppSuperuser } from '../helpers/rls';

/**
 * Onboarding creates BOTH Stripe objects, and they point opposite ways.
 *
 *   Account  — the club RECEIVES money. Destination charges settle into it.
 *   Customer — the club PAYS us. Their plan subscription bills against it,
 *              and `planTier` — our commission — follows from it.
 *
 * Only the account was ever created. `stripeCustomerId` was declared on
 * VenueOrg and written by nothing, so `handleSubscriptionUpserted` had
 * nothing to resolve a venue by — which is why the plan tier path shipped
 * correct and UNREACHABLE. The last test here is the one that matters: it
 * closes that join end to end.
 */
describe('Stripe Connect onboarding', () => {
  const db = prismaTestClient();
  useMswServer();

  let tenant: SeededTenant;

  beforeEach(async () => {
    tenant = await seedTenant();
  });

  const onboard = () =>
    asAppSuperuser(db, (tx: PrismaClient) =>
      startConnectOnboarding(tx, {
        tenantId: tenant.tenantId,
        actorUserId: tenant.userId,
        returnUrl: 'https://playerz.bg/settings/payouts',
        refreshUrl: 'https://playerz.bg/settings/payouts',
      }),
    );

  const venue = () =>
    asAppSuperuser(db, (tx) => tx.venueOrg.findUniqueOrThrow({ where: { id: tenant.tenantId } }));

  it('creates the payouts account and stores its id', async () => {
    await onboard();

    const v = await venue();
    expect(v.stripeAccountId).toMatch(/^acct_test_/);
  });

  it('creates the BILLING customer too, and stores its id', async () => {
    await onboard();

    const v = await venue();
    expect(v.stripeCustomerId).toMatch(/^cus_test_/);

    // Asserted on what went over the wire, not on our own call.
    const req = findRequest('/v1/customers');
    const body = req!.body as Record<string, string>;
    expect(body.email).toBe(v.contactEmail);
    expect(body['metadata[tenantId]']).toBe(tenant.tenantId);
  });

  it('is idempotent — a second onboarding creates neither again', async () => {
    await onboard();
    const first = await venue();

    recorded.length = 0;
    await onboard();
    const second = await venue();

    expect(second.stripeAccountId).toBe(first.stripeAccountId);
    expect(second.stripeCustomerId).toBe(first.stripeCustomerId);
    // Not merely "the same id came back" — Stripe was not asked at all.
    expect(findRequest('/v1/customers')).toBeUndefined();
    expect(findRequest('/v1/accounts')).toBeUndefined();
  });

  it('creates a customer for a venue that already had an account', async () => {
    // The upgrade path for every club onboarded before billing existed.
    // Nesting the customer inside the `if (!stripeAccountId)` block would skip
    // all of them, for ever.
    await asAppSuperuser(db, (tx) =>
      tx.venueOrg.update({
        where: { id: tenant.tenantId },
        data: { stripeAccountId: 'acct_test_preexisting' },
      }),
    );

    await onboard();

    const v = await venue();
    expect(v.stripeAccountId).toBe('acct_test_preexisting');
    expect(v.stripeCustomerId).toMatch(/^cus_test_/);
  });

  it('CLOSES THE JOIN: a subscription can now find the venue', async () => {
    // The whole point. Before this, `handleSubscriptionUpserted` resolved the
    // venue by `stripeCustomerId` and no code path had ever written one — so
    // the plan tier, and therefore our commission, could never move off FREE.
    await onboard();
    const v = await venue();
    expect(v.planTier).toBe('FREE');

    const r = await asAppSuperuser(db, (tx) =>
      handleSubscriptionUpserted(tx, {
        id: 'sub_onboarded',
        customer: v.stripeCustomerId,
        status: 'active',
        items: { data: [{ price: { id: process.env.STRIPE_PRICE_ID_PRO } }] },
      } as never),
    );

    expect(r.handled).toBe(true);

    const after = await venue();
    expect(after.planTier).toBe('PRO');
    expect(after.stripeSubscriptionId).toBe('sub_onboarded');
  });
});
