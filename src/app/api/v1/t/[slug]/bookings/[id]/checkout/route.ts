import { type NextRequest } from 'next/server';

import { getOwnBooking } from '@/app-layer/repositories/booking';
import { checkoutBooking } from '@/app-layer/usecases/payments';
import { inTenant } from '@/app/api/v1/_lib/bind';
import { contextFromRequest } from '@/app/api/v1/_lib/context';
import { defineV1Route } from '@/app/api/v1/_lib/define-route';
import { ok } from '@/app/api/v1/_lib/envelope';
import { recordPaymentAndConfirm } from '@/lib/billing/booking-payment';
import { ConflictError, NotFoundError, UnauthorizedError } from '@/lib/errors/types';
import { getRequestId } from '@/lib/observability/context';

/**
 * Pay for a booking.
 *
 * ═══ OWN BOOKINGS ONLY, WITH NO STAFF ESCAPE HATCH ═══
 *
 * Cancel has one, because the desk taking a phone call is a real workflow.
 * Paying is not: `bookings.view_all` must not let a manager charge a
 * player's saved card. The only person who may put money on this booking is
 * the person who made it.
 *
 * ═══ THE WALLET-ONLY PATH CONFIRMS INLINE ═══
 *
 * `checkoutBooking` deliberately does NOT create a zero-amount PaymentIntent
 * when credit covers the whole price — Stripe rejects those, and there is
 * nothing to charge. The consequence, found in review of 10a before this route
 * existed: no intent means no `payment_intent.succeeded`, which means the
 * webhook that confirms bookings never fires, which means a booking paid
 * entirely from credit would sit PENDING until its slot expired.
 *
 * So when nothing is due on a card, this route performs the confirmation
 * itself — through the SAME `recordPaymentAndConfirm` the webhook uses, so the
 * two paths cannot drift.
 *
 * ═══ WHAT THE CLIENT GETS ═══
 *
 * A PaymentSheet needs the client secret and the publishable key. The wallet
 * split is returned too so the app can say "€10 from credit, €14 on card"
 * rather than presenting a total that does not match the booking price and
 * looks like a bug.
 */
type Ctx = { params: Promise<{ slug: string; id: string }> };

async function handler(req: NextRequest, { params }: Ctx) {
  const { slug, id } = await params;
  const ctx = await contextFromRequest(req, { slug, requestId: getRequestId() });

  if (!ctx.userId) throw new UnauthorizedError('Authentication required');

  const useWallet = await req
    .json()
    .then((b: { useWallet?: unknown }) => b?.useWallet === true)
    // A body-less POST means "card only", which is the conservative reading:
    // spending someone's credit because they omitted a field would be taking
    // a decision that is theirs.
    .catch(() => false);

  // ═══ SERIALIZABLE, AND NOT BY PREFERENCE ═══
  //
  // Spending wallet credit goes through `appendEntry`, which REQUIRES
  // SERIALIZABLE and checks that it actually got it. Postgres can only set
  // isolation on the outermost BEGIN, so a use case asking for it on a handle
  // that is already inside a transaction gets a SAVEPOINT and silently keeps
  // READ COMMITTED — which for a ledger means two concurrent spends can both
  // read the same balance and both succeed.
  //
  // Found by that guard refusing at runtime rather than by reasoning: without
  // this option the route 500s on every wallet checkout with
  // LedgerIsolationError. The guard doing its job is why this is a failed test
  // and not a money bug in production.
  const result = await inTenant(
    ctx,
    async (db) => {
      const booking = await getOwnBooking(db, ctx.tenantId!, {
        bookingId: id,
        userId: ctx.userId!,
      });

      // 404 rather than 403 for somebody else's booking — a 403 confirms it
      // exists, which enumerates the club's reservations one id at a time.
      if (!booking) throw new NotFoundError('Booking not found');

      if (booking.status !== 'PENDING') {
        throw new ConflictError(
          booking.status === 'CONFIRMED'
            ? 'This booking is already paid for'
            : `A ${booking.status.toLowerCase()} booking cannot be paid for`,
        );
      }

      const quote = await checkoutBooking(db, {
        tenantId: ctx.tenantId!,
        userId: ctx.userId!,
        bookingId: booking.id,
        useWallet,
      });

      if (quote.cardDueCents === 0) {
        // Credit covered it. No Stripe leg exists, so nothing else will ever
        // confirm this booking.
        await recordPaymentAndConfirm(db, {
          booking: {
            id: booking.id,
            tenantId: ctx.tenantId!,
            status: booking.status,
            totalCents: booking.totalCents,
            currency: booking.currency,
          },
          provider: 'WALLET',
          // Unique per booking, which is what `(provider, providerRefId)`
          // requires — and a second checkout of the same booking must not
          // record a second wallet payment.
          providerRefId: `wallet:${booking.id}`,
          receivedCents: 0,
          creditUsedCents: quote.walletAppliedCents,
        });
      }

      return quote;
    },
    { isolationLevel: 'Serializable' },
  );

  return ok({
    bookingId: id,
    walletAppliedCents: result.walletAppliedCents,
    cardDueCents: result.cardDueCents,
    paymentIntentId: result.paymentIntentId,
    clientSecret: result.clientSecret,
    // Publishable by definition — it is in the iOS binary either way. Returned
    // here so the app does not need a second config endpoint or a rebuild to
    // follow a key rotation.
    publishableKey: process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY ?? null,
    // True when nothing was charged and the booking is already confirmed, so
    // the client knows not to present a PaymentSheet.
    confirmed: result.cardDueCents === 0,
  });
}

export const POST = defineV1Route(handler);
