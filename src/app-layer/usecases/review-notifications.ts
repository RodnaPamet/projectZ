import { deliver } from '@/app-layer/usecases/notification-outbox';
import { runAsUserOnly, runInTenantContext } from '@/lib/db/rls-middleware';
import { refusalOf, REFUSAL_SELECT } from '@/lib/moderation/refusal';
import { dedupeKey } from '@/lib/notifications/dedupe';
import {
  REVIEW_REFUSED_HREF,
  reviewRefusedBellCopy,
  reviewRefusedEmail,
  type ReviewTarget,
} from '@/lib/notifications/review-copy';
import { logger } from '@/lib/observability/logger';

/**
 * Tell the author their review was refused (#714, DSA Art. 17): the bell, and
 * an `account` email — an account notice, which no switch turns off, as the
 * privacy policy says of notices about one's own account.
 *
 * Called after the change committed: by `createReview` / `createCoachReview`
 * when the classifier refused the text, and by the moderation route when a
 * moderator refused or removed one. Everything it says is read back from the
 * review row (its `refusal*` columns), so the notice can only describe the
 * decision that was stored. Never throws.
 *
 * One notice per decision: the dedupe key names the review and the moment it
 * was refused, so a moderator confirming an automatic refusal is a second
 * notice (decided by a person now), and a hook that fires twice is one.
 */
export async function notifyReviewRefused(input: {
  subject: 'REVIEW' | 'COACH_REVIEW';
  tenantId: string;
  reviewId: string;
}): Promise<void> {
  try {
    const row = await runInTenantContext(input.tenantId, async (db) => {
      if (input.subject === 'REVIEW') {
        const r = await db.review.findFirst({
          where: { id: input.reviewId, tenantId: input.tenantId },
          select: {
            authorUserId: true,
            status: true,
            ...REFUSAL_SELECT,
            venue: { select: { name: true } },
          },
        });
        if (!r) return null;
        const target: ReviewTarget = { kind: 'venue', venue: r.venue.name };
        return { ...r, target, refType: 'review' };
      }
      const r = await db.coachReview.findFirst({
        where: { id: input.reviewId, tenantId: input.tenantId },
        select: { authorUserId: true, coachUserId: true, status: true, ...REFUSAL_SELECT },
      });
      if (!r) return null;
      const coach = await db.user.findFirst({
        where: { id: r.coachUserId, deletedAt: null },
        select: { name: true },
      });
      const target: ReviewTarget = { kind: 'coach', coach: coach?.name ?? null };
      return { ...r, target, refType: 'coach_review' };
    });
    const refusal = row ? refusalOf(row) : null;
    if (!row || !refusal) return;

    const author = await runAsUserOnly(row.authorUserId, (db) =>
      db.user.findUnique({
        where: { id: row.authorUserId },
        select: { locale: true, deletedAt: true },
      }),
    );
    if (!author || author.deletedAt) return;

    const [bell, email] = await Promise.all([
      reviewRefusedBellCopy(author.locale, refusal, row.target),
      reviewRefusedEmail(author.locale, refusal, row.target),
    ]);
    await deliver({
      userId: row.authorUserId,
      tenantId: input.tenantId,
      kind: 'REVIEW_REFUSED',
      dedupeKey: dedupeKey('review-refused', input.reviewId, refusal.decidedAt.getTime()),
      title: bell.title,
      body: bell.body,
      href: REVIEW_REFUSED_HREF,
      refType: row.refType,
      refId: input.reviewId,
      email: { category: 'account', locale: author.locale, ...email },
    });
  } catch (err) {
    logger.warn('review refusal not announced', {
      component: 'notifications',
      subject: input.subject,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
