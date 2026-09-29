'use server';

import { revalidatePath } from 'next/cache';

import {
  AlreadyReviewedError,
  createReview,
  NoProofOfVisitError,
  REVIEW_MAX_LENGTH,
} from '@/app-layer/usecases/reviews';
import { requireTenantAction, TenantActionDeniedError } from '@/lib/auth/page-context';
import { runInTenantContext } from '@/lib/db/rls-middleware';

/**
 * A player reviews a venue from their own bookings list.
 *
 * ═══ THE SAME USE CASE AS THE API, NOT A SECOND ONE ═══
 *
 * `POST /api/v1/t/{slug}/bookings/{id}/review` is the write the native client
 * calls. This is the web's transport to the same `createReview`, so the proof
 * of visit, the moderation and the one-review-per-venue rule are enforced
 * once, in one place.
 *
 * A Server Action rather than a fetch to that route, for one measured reason:
 * the edge refuses `/api/v1/t/{slug}/**` to a token whose membership list lacks
 * the slug, and memberships are written into the token at sign-in — so a player
 * who joined a club BY booking it (#229) is refused there until they sign in
 * again (#250). This action posts to `/me/bookings`, and resolves the
 * membership from the database instead.
 *
 * ═══ HOW IT AUTHORISES ═══
 *
 * `requireTenantAction(slug, 'bookings.create')` — an ACTIVE membership at the
 * booking's club, read from the database, holding the weakest permission every
 * member has. The same rule the API route's permission table states. A slug
 * the client altered buys nothing: the booking is then looked for at THAT club,
 * is not the caller's there, and the review is refused as no proof of visit.
 */

type ReviewActionError =
  'RATING_REQUIRED' | 'TOO_LONG' | 'NO_PROOF_OF_VISIT' | 'ALREADY_REVIEWED' | 'NOT_ALLOWED';

type ActionResult = { ok: true } | { ok: false; error: ReviewActionError };

export async function reviewBookingAction(
  slug: string,
  bookingId: string,
  _prev: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  let ctx;
  try {
    ctx = await requireTenantAction(slug, 'bookings.create');
  } catch (err) {
    // A suspended member, or a club that is gone. Said as a message rather
    // than an error boundary: the list that offered the form is still valid.
    if (err instanceof TenantActionDeniedError) return { ok: false, error: 'NOT_ALLOWED' };
    throw err;
  }

  const rating = Number(form.get('rating'));
  const raw = form.get('body');
  const body = typeof raw === 'string' ? raw : '';

  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    return { ok: false, error: 'RATING_REQUIRED' };
  }
  if (body.length > REVIEW_MAX_LENGTH) return { ok: false, error: 'TOO_LONG' };

  const { tenantId, userId } = ctx;

  try {
    await createReview((fn) => runInTenantContext(tenantId, fn), {
      tenantId,
      bookingId,
      authorUserId: userId,
      rating,
      body,
    });
  } catch (err) {
    if (err instanceof NoProofOfVisitError) return { ok: false, error: 'NO_PROOF_OF_VISIT' };
    if (err instanceof AlreadyReviewedError) return { ok: false, error: 'ALREADY_REVIEWED' };
    throw err;
  }

  // The list re-renders from the database, so the form gives way to the review
  // as it was stored — including whether it is live or waiting for a moderator.
  revalidatePath('/me/bookings');
  return { ok: true };
}
