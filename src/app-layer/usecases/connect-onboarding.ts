import type { PrismaClient } from '@prisma/client';

import { appendAuditEntry, AUDIT_ACTIONS } from '@/lib/audit';
import {
  createBillingCustomer,
  createConnectedAccount,
  createOnboardingLink,
} from '@/lib/billing/connect';

/**
 * Getting a club to the point where it can be paid.
 *
 * Until a venue has a `stripeAccountId` AND `payoutsEnabled`, `checkoutBooking`
 * throws `PayoutsNotEnabledError` and every other piece of the payment path is
 * unusable for real money. Both helpers this calls have existed, correct and
 * complete, with zero call sites — so no venue could ever obtain one.
 *
 * ═══ THE ACCOUNT IS CREATED ONCE, AND ONLY ONCE ═══
 *
 * Two things protect that, because one is not enough:
 *
 *   - the stored `stripeAccountId` is reused when present, so the ordinary
 *     second click just mints a fresh link;
 *   - and the creation carries an idempotency key derived from the tenant, so
 *     two SIMULTANEOUS clicks — where neither has stored an id yet — resolve
 *     to the same Stripe account rather than orphaning one.
 *
 * The second matters because the side effect is external. A database
 * transaction can roll back our row; it cannot un-create an Express account
 * sitting in the club's Stripe dashboard, half-onboarded, that nothing here
 * knows about.
 *
 * ═══ payoutsEnabled IS NOT SET HERE ═══
 *
 * Deliberately. Finishing Stripe's onboarding form is not the same as Stripe
 * having accepted the club's identity documents, and only the
 * `account.updated` webhook knows the difference. Setting it optimistically
 * here would let a club take bookings whose money can never be paid out.
 */

export interface OnboardingResult {
  stripeAccountId: string;
  url: string;
  payoutsEnabled: boolean;
  /** True when this call created the Stripe account rather than reusing one. */
  created: boolean;
}

export async function startConnectOnboarding(
  db: PrismaClient,
  input: { tenantId: string; actorUserId: string; returnUrl: string; refreshUrl: string },
): Promise<OnboardingResult> {
  const venue = await db.venueOrg.findUniqueOrThrow({
    where: { id: input.tenantId },
    select: {
      id: true,
      name: true,
      contactEmail: true,
      country: true,
      stripeAccountId: true,
      stripeCustomerId: true,
      payoutsEnabled: true,
    },
  });

  let stripeAccountId = venue.stripeAccountId;
  const created = !stripeAccountId;

  if (!stripeAccountId) {
    stripeAccountId = await createConnectedAccount({
      email: venue.contactEmail,
      venueName: venue.name,
      country: venue.country,
      idempotencyKey: `connect:account:${venue.id}`,
    });

    await db.venueOrg.update({
      where: { id: venue.id },
      data: { stripeAccountId },
    });

    await appendAuditEntry(db, {
      tenantId: venue.id,
      actorUserId: input.actorUserId,
      entity: 'VenueOrg',
      entityId: venue.id,
      action: AUDIT_ACTIONS.CONNECT_ACCOUNT_CREATED,
      details: `Stripe Connect account ${stripeAccountId} created for ${venue.name}`,
      detailsJson: {
        category: 'billing',
        summary: 'Stripe Connect account created',
        after: { stripeAccountId },
      },
    });
  }

  // ═══ AND THE VENUE AS A CUSTOMER OF OURS ═══
  //
  // The other direction. The Connect account is how the club RECEIVES money;
  // the customer is how they PAY us, and it is what their plan subscription
  // bills against.
  //
  // Created here rather than at upgrade time because
  // `handleSubscriptionUpserted` resolves the venue by `stripeCustomerId`.
  // With no customer there is nothing to join on — which is exactly why the
  // plan tier path shipped correct and unreachable.
  //
  // Separate from the account block above, deliberately: a venue that already
  // has an account from before this existed still needs a customer, and
  // nesting this inside `if (!stripeAccountId)` would skip every one of them
  // for ever.
  if (!venue.stripeCustomerId) {
    const stripeCustomerId = await createBillingCustomer({
      email: venue.contactEmail,
      venueName: venue.name,
      tenantId: venue.id,
      idempotencyKey: `billing:customer:${venue.id}`,
    });

    await db.venueOrg.update({
      where: { id: venue.id },
      data: { stripeCustomerId },
    });

    await appendAuditEntry(db, {
      tenantId: venue.id,
      actorUserId: input.actorUserId,
      entity: 'VenueOrg',
      entityId: venue.id,
      action: AUDIT_ACTIONS.BILLING_CUSTOMER_CREATED,
      details: `Stripe billing customer ${stripeCustomerId} created for ${venue.name}`,
      detailsJson: {
        category: 'billing',
        summary: 'Stripe billing customer created',
        after: { stripeCustomerId },
      },
    });
  }

  // A fresh link every time, including for an existing account. Stripe's
  // onboarding links expire, so handing back a stored one would eventually
  // send the club to a dead page with no way to act on it.
  const url = await createOnboardingLink({
    stripeAccountId,
    returnUrl: input.returnUrl,
    refreshUrl: input.refreshUrl,
  });

  return { stripeAccountId, url, payoutsEnabled: venue.payoutsEnabled, created };
}
