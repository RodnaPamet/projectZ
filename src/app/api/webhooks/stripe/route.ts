import { type NextRequest, NextResponse } from 'next/server';
import type { PrismaClient } from '@prisma/client';
import type Stripe from 'stripe';

import {
  handleAccountUpdated,
  handleInvoicePaid,
  handleSubscriptionDeleted,
  handleSubscriptionUpserted,
} from '@/lib/billing/webhook-handlers';
import { notifyAfterCommit, type NotifyInput } from '@/app-layer/usecases/notifications';
import { handlePaymentIntentSucceeded } from '@/lib/billing/booking-payment';
import { runAsSuperuser } from '@/lib/db/rls-middleware';
import { WebhookSignatureError, verifyStripeWebhook } from '@/lib/stripe';

/**
 * Stripe webhook.
 *
 * Unauthenticated by necessity — Stripe has no session. The SIGNATURE is
 * the authentication, so it is verified against the RAW body before
 * anything else happens. `req.json()` would already have destroyed the
 * bytes the signature was computed over.
 *
 * ═══ DELIVERY IS AT LEAST ONCE, SO PROCESSING IS ONCE ═══
 *
 * Stripe retries on any non-2xx and will deliver the same event twice in
 * ordinary operation; an event can also be replayed from the dashboard. Until
 * P28 the only protection was the signed timestamp inside `constructEvent`, so
 * a replay inside that tolerance window was processed again.
 *
 * Every handled event now claims its `event.id` in `webhook_event` first, and
 * a claim that loses to an existing row means we have already done this work.
 *
 * ═══ THE CLAIM AND THE WORK SHARE ONE TRANSACTION ═══
 *
 * That is the part worth being careful about. If the claim committed
 * separately and the work then failed, the event would be permanently marked
 * done while nothing had happened — and Stripe's retry, the one mechanism that
 * could have fixed it, would be turned away by our own dedupe row.
 *
 * Sharing the transaction means a failure rolls back BOTH, the retry arrives
 * to an unclaimed event, and the work happens. Success commits both, and the
 * replay is a no-op.
 */
export async function POST(req: NextRequest) {
  const raw = await req.text();

  let event;
  try {
    event = verifyStripeWebhook(raw, req.headers.get('stripe-signature'));
  } catch (e) {
    if (e instanceof WebhookSignatureError) {
      // 400, not 500: this is a rejected forgery, not our bug. A 5xx would
      // make Stripe retry an attacker's payload for days.
      return NextResponse.json({ error: 'invalid_signature' }, { status: 400 });
    }
    throw e;
  }

  // Set by the handler, sent after the transaction commits. Writing it inside
  // would hold this transaction open across a call to Apple, and would put a
  // banner on the phone even if the transaction — including the event claim —
  // then rolled back.
  let pending: NotifyInput | undefined;

  const dispatch = async (db: PrismaClient): Promise<Record<string, unknown>> => {
    // Claim the event. `createMany` with skipDuplicates compiles to
    // INSERT ... ON CONFLICT DO NOTHING, which — unlike a caught unique
    // violation — does not abort the transaction we still need.
    const claim = await db.webhookEvent.createMany({
      data: [{ provider: 'STRIPE', eventId: event.id, eventType: event.type }],
      skipDuplicates: true,
    });

    if (claim.count === 0) {
      return { received: true, type: event.type, duplicate: true };
    }

    switch (event.type) {
      case 'payment_intent.succeeded': {
        const r = await handlePaymentIntentSucceeded(db, event.data.object as Stripe.PaymentIntent);
        // `notify` rides out of the transaction and is sent after the commit —
        // see below. Stripped from the response body: Stripe has no use for a
        // notification payload in a webhook reply.
        const { notify, ...body } = r;
        pending = notify;
        return { received: true, type: event.type, ...body };
      }

      // The ONLY thing that may set `payoutsEnabled`. See handleAccountUpdated.
      case 'account.updated': {
        const r = await handleAccountUpdated(db, event.data.object as Stripe.Account);
        return { received: true, type: event.type, ...r };
      }

      case 'invoice.paid': {
        const r = await handleInvoicePaid(db, event.data.object as Stripe.Invoice);
        return { received: true, type: event.type, ...r };
      }

      // Created AND updated: an upgrade arrives as `updated`, and without both
      // cases they fell through to `default:` and were answered
      // `{received: true, ignored: ...}` — which is how the venue's
      // subscription id never got written in the first place.
      case 'customer.subscription.created':
      case 'customer.subscription.updated': {
        const r = await handleSubscriptionUpserted(db, event.data.object as Stripe.Subscription);
        return { received: true, type: event.type, ...r };
      }

      case 'customer.subscription.deleted': {
        const r = await handleSubscriptionDeleted(db, event.data.object as Stripe.Subscription);
        return { received: true, type: event.type, ...r };
      }

      default:
        // Acknowledge everything else. A non-2xx makes Stripe retry forever —
        // and an event we do not handle is not an error, it is just noise.
        //
        // The claim row is still written, so an unhandled event is recorded as
        // seen. That is deliberate: it makes "did this arrive?" answerable
        // without reading Stripe's dashboard.
        return { received: true, ignored: event.type };
    }
  };

  const body = await runAsSuperuser(dispatch);

  // Committed. `notifyAfterCommit` never throws: a push failure must not make
  // this a non-2xx, because Stripe would retry an event we have already
  // claimed and the retry would be discarded as a duplicate.
  if (pending) await notifyAfterCommit(pending);

  return NextResponse.json(body);
}
