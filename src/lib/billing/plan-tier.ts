import type { PlanTier } from '@prisma/client';
import type Stripe from 'stripe';

import { env } from '@/env';

/**
 * Which plan a Stripe price id means, and therefore what commission we take.
 *
 * ═══ WHY THIS EXISTS ═══
 *
 * `PLATFORM_FEE_BPS` charges 5% on FREE, 3% on CLUB and 1.5% on PRO, and is
 * well tested. `venueOrg.planTier` was its only input — and NOTHING IN src/
 * EVER WROTE IT. Two reads, no writers, outside a test helper.
 *
 * So every club sat on FREE for ever. A club that upgraded through Stripe
 * Billing paid 5% instead of 1.5% on every booking — 120¢ instead of 36¢ on a
 * €24 court — and the only signal was the word "handled" in a webhook response
 * nobody reads.
 *
 * ═══ NULL MEANS "DO NOT TOUCH THE TIER" ═══
 *
 * An unrecognised price id returns null, never FREE. Defaulting to FREE would
 * silently DOWNGRADE a paying club the day somebody rotates a price in the
 * Stripe dashboard and forgets the environment variable — quietly tripling our
 * commission against a customer who is up to date. Null means we do not know,
 * the caller reports the event as unhandled, and the tier stays as it was.
 */
export function planTierForPriceId(priceId: string | null | undefined): PlanTier | null {
  if (!priceId) return null;

  if (env.STRIPE_PRICE_ID_PRO && priceId === env.STRIPE_PRICE_ID_PRO) return 'PRO';
  if (env.STRIPE_PRICE_ID_CLUB && priceId === env.STRIPE_PRICE_ID_CLUB) return 'CLUB';

  return null;
}

/** `string | Price | null` → an id, the way the webhook handlers normalise elsewhere. */
function toId(value: string | { id: string } | null | undefined): string | null {
  if (!value) return null;
  return typeof value === 'string' ? value : value.id;
}

/**
 * The plan price id on an invoice.
 *
 * Scans every line rather than taking `lines.data[0]`. An invoice can carry
 * proration lines alongside the plan line, and their order is not something
 * to rely on — picking index 0 would read a proration's price and resolve to
 * null, leaving the tier unchanged on exactly the upgrade that needed it.
 */
export function priceIdFromInvoice(invoice: Stripe.Invoice): string | null {
  for (const line of invoice.lines?.data ?? []) {
    // `pricing` is nullable in the 2025 API shape.
    const priceId = toId(line.pricing?.price_details?.price);
    if (priceId && planTierForPriceId(priceId)) return priceId;
  }
  return null;
}

/** The plan price id on a subscription. */
export function priceIdFromSubscription(subscription: Stripe.Subscription): string | null {
  for (const item of subscription.items?.data ?? []) {
    const priceId = toId(item.price);
    if (priceId && planTierForPriceId(priceId)) return priceId;
  }
  return null;
}

/**
 * A subscription that is not paying does not get a discounted commission.
 *
 * `past_due`, `unpaid`, `canceled`, `incomplete_expired` all mean the club is
 * not currently a paying customer. Keeping them on PRO would hand out the
 * 1.5% rate to somebody whose card has been failing for a month.
 *
 * `trialing` DOES count — a trial is a deliberate offer, not a failure.
 */
export function isPayingStatus(status: Stripe.Subscription.Status): boolean {
  return status === 'active' || status === 'trialing';
}
