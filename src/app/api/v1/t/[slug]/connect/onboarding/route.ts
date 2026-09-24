import { type NextRequest } from 'next/server';

import { startConnectOnboarding } from '@/app-layer/usecases/connect-onboarding';
import { hasPermission } from '@/app-layer/types';
import { inTenant } from '@/app/api/v1/_lib/bind';
import { contextFromRequest } from '@/app/api/v1/_lib/context';
import { defineV1Route } from '@/app/api/v1/_lib/define-route';
import { ok } from '@/app/api/v1/_lib/envelope';
import { ForbiddenError, UnauthorizedError } from '@/lib/errors/types';
import { getRequestId } from '@/lib/observability/context';

/**
 * Start (or resume) Stripe Connect onboarding for a club.
 *
 * This is the piece without which none of the rest of the payment path works:
 * `checkoutBooking` throws `PayoutsNotEnabledError` until a venue has both a
 * `stripeAccountId` and `payoutsEnabled`, and nothing could produce the former
 * — `createConnectedAccount` and `createOnboardingLink` have both existed,
 * correct and complete, with zero call sites.
 *
 * ═══ THE RETURN URLS COME FROM THE SERVER, NOT THE REQUEST ═══
 *
 * A caller-supplied `returnUrl` is an open redirect with extra steps: Stripe
 * would send the club's admin wherever the body said after they finish
 * onboarding, and that page looks like part of our flow because it is the last
 * step of it. Both URLs are built from NEXTAUTH_URL here.
 *
 * ═══ POST, NOT GET, EVEN THOUGH IT READS LIKE A LOOKUP ═══
 *
 * The first call CREATES a Stripe account. That is not idempotent in the HTTP
 * sense and must not sit behind a verb that a browser, a crawler or a
 * prefetcher will follow on its own.
 */
async function handler(req: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const ctx = await contextFromRequest(req, { slug, requestId: getRequestId() });

  if (!ctx.userId) throw new UnauthorizedError('Authentication required');

  // Connecting a bank account is where the club's money will land. It sits
  // with billing, which OWNER and MANAGER hold — not with anyone who can
  // merely manage venues.
  if (!hasPermission(ctx, 'admin.billing_manage')) {
    throw new ForbiddenError('Managing payouts requires billing permission');
  }

  const base = process.env.NEXTAUTH_URL ?? '';

  const result = await inTenant(ctx, (db) =>
    startConnectOnboarding(db, {
      tenantId: ctx.tenantId!,
      actorUserId: ctx.userId!,
      returnUrl: `${base}/t/${slug}/settings/payouts?onboarding=complete`,
      // Stripe sends the admin here when a link has expired, so it must start
      // a NEW onboarding rather than land on a page describing the old one.
      refreshUrl: `${base}/t/${slug}/settings/payouts?onboarding=refresh`,
    }),
  );

  return ok({
    stripeAccountId: result.stripeAccountId,
    onboardingUrl: result.url,
    // False until Stripe's `account.updated` webhook says otherwise. Finishing
    // the form is not the same as Stripe accepting the club's documents, and
    // a client that treats this as "done" will show a club it can take money
    // it cannot be paid.
    payoutsEnabled: result.payoutsEnabled,
    created: result.created,
  });
}

export const POST = defineV1Route(handler);
