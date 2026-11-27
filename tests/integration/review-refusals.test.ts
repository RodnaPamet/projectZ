import type { PrismaClient } from '@prisma/client';

import { notifyReviewRefused } from '@/app-layer/usecases/review-notifications';
import {
  createReview,
  reportContent,
  resolveCase,
  type TenantRunner,
} from '@/app-layer/usecases/reviews';
import type { ModerationResult } from '@/lib/moderation/classify';

import { prismaTestClient, seedTenant, type SeededTenant } from '../helpers/db';
import { useMswServer } from '../helpers/msw';
import { asAppSuperuser, asAppUser } from '../helpers/rls';

/**
 * A refused review is explained to its author (#714, DSA Art. 17): the
 * review row keeps what was decided (`refusal*`), and the author gets a
 * REVIEW_REFUSED bell row and an `account` email that say what was done,
 * why (a rule, never the scores), whether it was automatic, and how to
 * object. Against a real database, as the app's own role.
 */

const HOUR = 3_600_000;

let db: PrismaClient;
let tenant: SeededTenant;
let venueId: string;

useMswServer();

beforeAll(() => {
  db = prismaTestClient();
});

const inClub =
  (tenantId: string): TenantRunner =>
  (fn) =>
    asAppUser(db, tenantId, fn);

const verdict = (decision: ModerationResult['decision'], reason: string | null) => async () => ({
  decision,
  maxScore: 0.9,
  reason,
  scores: reason ? { [reason]: 0.9 } : {},
});

beforeEach(async () => {
  tenant = await seedTenant();
  venueId = await asAppSuperuser(db, async (tx) => {
    await tx.user.update({ where: { id: tenant.userId }, data: { locale: 'bg' } });
    const v = await tx.venue.create({
      data: {
        tenantId: tenant.tenantId,
        name: 'Сердика Тенис',
        slug: `venue-${Math.random().toString(36).slice(2, 10)}`,
        city: 'Sofia',
        addressLine: '1 Vitosha Blvd',
        lat: 42.6977,
        lng: 23.3219,
        email: 'v@playerz.test',
      },
    });
    return v.id;
  });
});

async function seedCompletedBooking() {
  return asAppSuperuser(db, async (tx) => {
    const resource = await tx.resource.create({
      data: {
        tenantId: tenant.tenantId,
        venueId,
        name: 'Court 1',
        sport: 'TENNIS',
        resourceType: 'COURT',
        surface: 'HARD',
        basePriceCents: 2400,
      },
    });
    return tx.booking.create({
      data: {
        tenantId: tenant.tenantId,
        resourceId: resource.id,
        startTs: new Date(Date.now() - 2 * HOUR),
        endTs: new Date(Date.now() - HOUR),
        bookedByUserId: tenant.userId,
        status: 'COMPLETED',
        totalCents: 2400,
        idempotencyKey: `idem-${Math.random().toString(36).slice(2, 12)}`,
      },
    });
  });
}

const review = async (moderate: () => Promise<ModerationResult>) => {
  const booking = await seedCompletedBooking();
  return createReview(
    inClub(tenant.tenantId),
    {
      tenantId: tenant.tenantId,
      bookingId: booking.id,
      authorUserId: tenant.userId,
      rating: 1,
      body: 'some words',
    },
    moderate,
  );
};

const notices = () =>
  asAppSuperuser(db, (tx) =>
    tx.notification.findMany({
      where: { userId: tenant.userId, kind: 'REVIEW_REFUSED' },
      orderBy: { createdAt: 'asc' },
    }),
  );
const emails = () =>
  asAppSuperuser(db, (tx) =>
    tx.emailOutbox.findMany({
      where: { userId: tenant.userId, kind: 'REVIEW_REFUSED' },
      orderBy: { createdAt: 'asc' },
    }),
  );
const stored = (id: string) =>
  asAppSuperuser(db, (tx) =>
    tx.review.findUniqueOrThrow({
      where: { id },
      select: {
        status: true,
        refusalReason: true,
        refusalAutomated: true,
        refusalRemoved: true,
        refusedAt: true,
      },
    }),
  );
const openCase = (reviewId: string) =>
  asAppSuperuser(db, (tx) =>
    tx.moderationCase.findFirstOrThrow({
      where: { subjectType: 'REVIEW', subjectId: reviewId, status: 'OPEN' },
    }),
  );

describe('the classifier refuses a review', () => {
  it('stores the rule, tells the author at once by bell and email, and says it was automatic', async () => {
    const r = await review(verdict('REJECTED', 'sexual/minors'));

    expect(r.status).toBe('REJECTED');
    expect(r.refusal).toMatchObject({
      action: 'NOT_PUBLISHED',
      reason: 'sexual_minors',
      automated: true,
    });
    expect(await stored(r.id)).toMatchObject({
      refusalReason: 'sexual_minors',
      refusalAutomated: true,
      refusalRemoved: false,
    });

    const [bell, ...more] = await notices();
    expect(more).toHaveLength(0);
    expect(bell).toMatchObject({
      title: 'Отзивът ви не е публикуван',
      href: '/me/bookings?tab=past',
      refType: 'review',
      refId: r.id,
      tenantId: tenant.tenantId,
    });
    expect(bell!.body).toBe(
      'Отзив за Сердика Тенис. Причина: сексуално съдържание с участие на деца. ' +
        'Решено автоматично. Не сте съгласни? Пишете на privacy@playerz.bg.',
    );

    const [mail] = await emails();
    expect(mail).toMatchObject({ category: 'account', locale: 'bg', status: 'PENDING' });
    expect(mail!.text).toContain('Отзивът ви за Сердика Тенис не е публикуван.');
    expect(mail!.text).toContain('модел с изкуствен интелект на Anthropic');
    expect(mail!.text).toContain('privacy@playerz.bg');
    // Never the scores.
    expect(mail!.text).not.toContain('0.9');
  });

  it('a review held for a moderator tells the author nothing yet', async () => {
    const r = await review(verdict('NEEDS_REVIEW', 'harassment'));
    expect(r.status).toBe('PENDING_REVIEW');
    expect(r.refusal).toBeNull();
    expect(await notices()).toHaveLength(0);
  });

  it('a hook that fires twice writes one notice', async () => {
    const r = await review(verdict('REJECTED', 'self-harm/instructions'));
    await notifyReviewRefused({ subject: 'REVIEW', tenantId: tenant.tenantId, reviewId: r.id });
    expect(await notices()).toHaveLength(1);
    expect(await emails()).toHaveLength(1);
  });
});

describe('a moderator decides', () => {
  it('refusing a held review: never published, by a person, on the rule they picked', async () => {
    const r = await review(verdict('NEEDS_REVIEW', 'harassment'));
    const c = await openCase(r.id);

    const res = await resolveCase(db, {
      caseId: c.id,
      moderatorUserId: tenant.userId,
      approve: false,
      note: 'names a private person',
      rule: 'personal_data',
    });
    expect(res.refused).toEqual({ subject: 'REVIEW', tenantId: tenant.tenantId, reviewId: r.id });
    // What the route does after the commit.
    await notifyReviewRefused(res.refused!);

    expect(await stored(r.id)).toMatchObject({
      status: 'REJECTED',
      refusalReason: 'personal_data',
      refusalAutomated: false,
      refusalRemoved: false,
    });
    const [bell] = await notices();
    expect(bell!.title).toBe('Отзивът ви не е публикуван');
    expect(bell!.body).toContain('Причина: лични данни на друг човек. Решено от модератор.');
    const [mail] = await emails();
    expect(mail!.text).toContain('от модератор от екипа на playerz.bg');
    // The moderator's note is for the audit trail, not the author.
    expect(mail!.text).not.toContain('names a private person');
  });

  it('with no rule named, the case’s category is the reason', async () => {
    const r = await review(verdict('NEEDS_REVIEW', 'hate'));
    const c = await openCase(r.id);
    await resolveCase(db, { caseId: c.id, moderatorUserId: tenant.userId, approve: false });
    expect((await stored(r.id)).refusalReason).toBe('hate');
  });

  it('taking down a published review after a report says it was REMOVED', async () => {
    const r = await review(verdict('APPROVED', null));
    // Published: nothing to tell.
    expect(await notices()).toHaveLength(0);
    const { caseId } = await reportContent(db, {
      tenantId: tenant.tenantId,
      subjectType: 'REVIEW',
      subjectId: r.id,
      reporterUserId: tenant.userId,
      reason: 'spam',
    });
    const res = await resolveCase(db, {
      caseId,
      moderatorUserId: tenant.userId,
      approve: false,
      rule: 'spam',
    });
    await notifyReviewRefused(res.refused!);

    expect(await stored(r.id)).toMatchObject({ refusalRemoved: true, refusalReason: 'spam' });
    const [bell] = await notices();
    expect(bell!.title).toBe('Отзивът ви е премахнат');
    const [mail] = await emails();
    expect(mail!.text).toContain('е премахнат и вече не се вижда');
  });

  it('confirming an automatic refusal is a second notice, now from a person', async () => {
    const r = await review(verdict('REJECTED', 'sexual/minors'));
    const c = await openCase(r.id);
    const res = await resolveCase(db, {
      caseId: c.id,
      moderatorUserId: tenant.userId,
      approve: false,
    });
    await notifyReviewRefused(res.refused!);

    expect(await stored(r.id)).toMatchObject({
      refusalReason: 'sexual_minors',
      refusalAutomated: false,
      refusalRemoved: false,
    });
    const rows = await notices();
    expect(rows).toHaveLength(2);
    expect(rows[1]!.body).toContain('Решено от модератор.');
  });

  it('publishing an automatically refused review clears the reasons and tells nothing more', async () => {
    const r = await review(verdict('REJECTED', 'sexual/minors'));
    const c = await openCase(r.id);
    const res = await resolveCase(db, {
      caseId: c.id,
      moderatorUserId: tenant.userId,
      approve: true,
    });
    expect(res.refused).toBeNull();
    expect(await stored(r.id)).toEqual({
      status: 'PUBLISHED',
      refusalReason: null,
      refusalAutomated: null,
      refusalRemoved: null,
      refusedAt: null,
    });
    expect(await notices()).toHaveLength(1);
  });
});
