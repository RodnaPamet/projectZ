import type { PrismaClient } from '@prisma/client';
import type Stripe from 'stripe';

import {
  isPayingStatus,
  planTierForPriceId,
  priceIdFromInvoice,
  priceIdFromSubscription,
} from './plan-tier';

/**
 * What each Stripe event actually does to our database.
 *
 * Kept out of the route so it can be tested by handing it an event object,
 * rather than by constructing a signed HTTP request for every case.
 *
 * ─── Every handler here MUST be idempotent ───────────────────────────
 *
 * Stripe retries on any non-2xx, and delivers at-least-once even when we
 * answered 200 — a network blip on the response is indistinguishable from a
 * failure. So each of these is written to be safely re-runnable: they set
 * absolute state (`payoutsEnabled = <what Stripe says>`) rather than
 * incrementing, or they update a row only when it is in the expected prior
 * state.
 *
 * A handler that credits a wallet on `invoice.paid` by INCREMENTING would
 * double-credit on a redelivery. There isn't one here, and there must not be
 * one added without a dedupe on `event.id`.
 */

export async function handleAccountUpdated(
  db: PrismaClient,
  account: Stripe.Account,
): Promise<{ handled: boolean }> {
  const venue = await db.venueOrg.findFirst({ where: { stripeAccountId: account.id } });
  if (!venue) return { handled: false };

  // MIRROR Stripe. Do not infer this from `details_submitted`, and do not
  // latch it to true once seen — Stripe can and does DISABLE payouts later
  // (a failed identity check, an expired document). If we latched, we would
  // keep taking bookings for a club that can no longer be paid, and discover
  // it only when the payouts started bouncing.
  const payoutsEnabled = account.payouts_enabled === true;

  await db.venueOrg.update({
    where: { id: venue.id },
    data: { payoutsEnabled },
  });

  return { handled: true };
}

/**
 * A membership subscription's invoice was paid → the membership is active.
 *
 * Idempotent because it sets `status: 'ACTIVE'` absolutely. A redelivery
 * re-activates an already-active membership, which is a no-op.
 */
export async function handleInvoicePaid(
  db: PrismaClient,
  invoice: Stripe.Invoice,
): Promise<{ handled: boolean }> {
  // Stripe's 2025 API moved this. It used to be `invoice.subscription`; it is
  // now nested under `parent.subscription_details`, and the old field is gone
  // — not deprecated, GONE. Reading the old path compiles fine against a loose
  // type and yields `undefined` at runtime, so every membership silently fails
  // to activate while the webhook cheerfully returns 200.
  const sub = invoice.parent?.subscription_details?.subscription ?? null;
  const subscriptionId = typeof sub === 'string' ? sub : (sub?.id ?? null);

  // An invoice with no subscription is a one-off charge, not a membership
  // renewal. Nothing to do — but say so, rather than pretending we handled it.
  if (!subscriptionId) return { handled: false };

  const membership = await db.membership.findUnique({
    where: { stripeSubscriptionId: subscriptionId },
  });

  if (membership) {
    await db.membership.update({
      where: { id: membership.id },
      data: { status: 'ACTIVE' },
    });
    return { handled: true };
  }

  // Not a player membership — maybe it is the VENUE's own subscription to us,
  // which sets their plan tier and therefore our commission.
  //
  // This branch used to look the venue up and `return { handled: true }`
  // having written NOTHING. A club upgrading FREE → PRO through Stripe Billing
  // was answered "handled", kept planTier FREE, and paid 5% instead of 1.5% on
  // every booking thereafter — 120¢ instead of 36¢ on a €24 court.
  const venue = await db.venueOrg.findUnique({
    where: { stripeSubscriptionId: subscriptionId },
  });

  if (!venue) return { handled: false };

  const planTier = planTierForPriceId(priceIdFromInvoice(invoice));

  // An unrecognised price is reported UNHANDLED rather than silently accepted.
  // Defaulting to FREE here would downgrade a paying club the day a price id
  // is rotated in the dashboard — tripling our commission against a customer
  // who is up to date.
  if (!planTier) return { handled: false };

  // Set absolutely, not incremented, so a redelivered invoice is a no-op —
  // the idempotency contract this file's header describes.
  await db.venueOrg.update({ where: { id: venue.id }, data: { planTier } });

  return { handled: true };
}

/**
 * The venue's subscription was created or changed → set the tier.
 *
 * ═══ THIS IS THE INGRESS THAT WAS MISSING ═══
 *
 * `handleInvoicePaid` finds the venue by `stripeSubscriptionId`. Nothing ever
 * WROTE that column, so that lookup could never match and the branch above was
 * unreachable in production — not merely wrong, unreachable. Fixing the write
 * without this would have changed nothing observable.
 *
 * ═══ AND A LAPSED SUBSCRIPTION LOSES THE DISCOUNT ═══
 *
 * `past_due` or `unpaid` means the card has been failing. Keeping that club on
 * PRO hands out the 1.5% rate to somebody who is not paying for it, and
 * because the tier is only ever read at checkout, nothing else would notice.
 */
export async function handleSubscriptionUpserted(
  db: PrismaClient,
  subscription: Stripe.Subscription,
): Promise<{ handled: boolean }> {
  const customerId =
    typeof subscription.customer === 'string' ? subscription.customer : subscription.customer?.id;

  if (!customerId) return { handled: false };

  const venue = await db.venueOrg.findUnique({ where: { stripeCustomerId: customerId } });

  // Not a venue subscription — a player membership arrives through its own
  // path. Unhandled rather than an error.
  if (!venue) return { handled: false };

  const priced = planTierForPriceId(priceIdFromSubscription(subscription));
  const planTier = isPayingStatus(subscription.status) ? priced : 'FREE';

  if (!planTier) return { handled: false };

  await db.venueOrg.update({
    where: { id: venue.id },
    data: { stripeSubscriptionId: subscription.id, planTier },
  });

  return { handled: true };
}

/**
 * A subscription lapsed → the membership is not active any more.
 *
 * Note this does NOT delete anything. A lapsed membership is a historical fact
 * (they were a member from March to September); deleting it would erase that,
 * and with it any booking discount they legitimately received at the time.
 */
export async function handleSubscriptionDeleted(
  db: PrismaClient,
  subscription: Stripe.Subscription,
): Promise<{ handled: boolean }> {
  const membership = await db.membership.findUnique({
    where: { stripeSubscriptionId: subscription.id },
  });

  if (membership) {
    await db.membership.update({
      where: { id: membership.id },
      data: { status: 'EXPIRED', autoRenew: false },
    });

    return { handled: true };
  }

  // The mirror of handleInvoicePaid: it may be the VENUE's subscription. This
  // only searched Membership, so a club that cancelled kept its discounted
  // commission for ever — we would go on taking 1.5% from a club paying us
  // nothing, and the cancellation would look handled.
  const venue = await db.venueOrg.findUnique({
    where: { stripeSubscriptionId: subscription.id },
  });

  if (!venue) return { handled: false };

  await db.venueOrg.update({
    where: { id: venue.id },
    // The link is cleared too. Leaving a dead subscription id would make a
    // later invoice for a NEW subscription match the wrong row.
    data: { planTier: 'FREE', stripeSubscriptionId: null },
  });

  return { handled: true };
}
