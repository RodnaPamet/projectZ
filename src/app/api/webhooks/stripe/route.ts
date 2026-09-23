import { type NextRequest, NextResponse } from 'next/server';
import type Stripe from 'stripe';

import {
  handleAccountUpdated,
  handleInvoicePaid,
  handleSubscriptionDeleted,
} from '@/lib/billing/webhook-handlers';
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
 * Confirming a booking is idempotent: Stripe retries on any non-2xx, and it
 * will happily deliver the same event twice. `updateMany` on a PENDING row
 * means the second delivery is a no-op rather than a second confirmation
 * email and a second set of reminder jobs.
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

  switch (event.type) {
    case 'payment_intent.succeeded':
      return NextResponse.json({ received: true, type: event.type });

    // The ONLY thing that may set `payoutsEnabled`. See handleAccountUpdated.
    case 'account.updated': {
      const r = await runAsSuperuser((db) =>
        handleAccountUpdated(db, event.data.object as Stripe.Account),
      );
      return NextResponse.json({ received: true, type: event.type, ...r });
    }

    case 'invoice.paid': {
      const r = await runAsSuperuser((db) =>
        handleInvoicePaid(db, event.data.object as Stripe.Invoice),
      );
      return NextResponse.json({ received: true, type: event.type, ...r });
    }

    case 'customer.subscription.deleted': {
      const r = await runAsSuperuser((db) =>
        handleSubscriptionDeleted(db, event.data.object as Stripe.Subscription),
      );
      return NextResponse.json({ received: true, type: event.type, ...r });
    }

    default:
      // Acknowledge everything else. A non-2xx makes Stripe retry forever —
      // and an event we do not handle is not an error, it is just noise.
      return NextResponse.json({ received: true, ignored: event.type });
  }
}
