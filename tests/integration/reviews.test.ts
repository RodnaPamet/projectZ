import type { PrismaClient } from '@prisma/client';

import { markNoShow, NoShowRefusedError } from '@/app-layer/usecases/booking-outcome';
import {
  AlreadyReviewedError,
  NoProofOfVisitError,
  createReview,
  recomputeVenueRating,
  reportContent,
  resolveCase,
  type TenantRunner,
} from '@/app-layer/usecases/reviews';
import { pgErrorCode } from '@/lib/db/pg-errors';
import type { ModerationResult } from '@/lib/moderation/classify';
import { InvalidRatingError } from '@/lib/ratings/score';

import { prismaTestClient, seedTenant, type SeededTenant } from '../helpers/db';
import { recorded, setModerationScores, useMswServer } from '../helpers/msw';
import { asAppSuperuser, asAppUser } from '../helpers/rls';

/**
 * Reviews and moderation.
 *
 * The Claude classifier is MSW-mocked, and NEVER reached for real: the MSW
 * server refuses any unhandled request. So these tests prove our POLICY and our
 * DATABASE, not the model's accuracy on Bulgarian — that can only be
 * established by running real Bulgarian text through the real model.
 *
 * What they do prove is the part that is ours to get wrong: that an unverified
 * stranger cannot review a venue, that nothing is visible before it is
 * moderated, and that a classifier outage queues rather than publishes.
 */

const HOUR = 3_600_000;

let db: PrismaClient;
let tenant: SeededTenant;
let venueId: string;
let otherUserId: string;

useMswServer();

beforeAll(() => {
  db = prismaTestClient();
});

/**
 * The binding the route and the server action use: one transaction per call,
 * as app_user, bound to the club — so RLS is live under every test here.
 */
const inClub =
  (tenantId: string): TenantRunner =>
  (fn) =>
    asAppUser(db, tenantId, fn);

const review = (
  input: { bookingId: string; authorUserId?: string; rating?: number; body?: string | null },
  moderate?: (text: string) => Promise<ModerationResult>,
) =>
  createReview(
    inClub(tenant.tenantId),
    {
      tenantId: tenant.tenantId,
      bookingId: input.bookingId,
      authorUserId: input.authorUserId ?? tenant.userId,
      rating: input.rating ?? 5,
      body: input.body,
    },
    moderate,
  );

const classifierCalls = () => recorded.filter((r) => r.url.includes('api.anthropic.com')).length;

const venueScore = () =>
  asAppSuperuser(db, (tx) =>
    tx.venue.findUniqueOrThrow({
      where: { id: venueId },
      select: { avgRating: true, reviewCount: true },
    }),
  ).then((v) => ({ avgRating: Number(v.avgRating), reviewCount: v.reviewCount }));

async function seedVenue(name = 'Court Complex') {
  return asAppSuperuser(db, (tx) =>
    tx.venue.create({
      data: {
        tenantId: tenant.tenantId,
        name,
        slug: `venue-${Math.random().toString(36).slice(2, 10)}`,
        city: 'Sofia',
        addressLine: '1 Vitosha Blvd',
        lat: 42.6977,
        lng: 23.3219,
        email: 'v@playerz.test',
      },
    }),
  );
}

beforeEach(async () => {
  tenant = await seedTenant();
  venueId = (await seedVenue()).id;

  otherUserId = await asAppSuperuser(db, (tx) =>
    tx.user
      .create({
        data: { email: `stranger-${Math.random().toString(36).slice(2, 8)}@playerz.test` },
      })
      .then((u) => u.id),
  );
});

/** A booking, in whatever state the test needs, on a court of its own. */
async function seedBooking(
  opts: {
    userId?: string;
    status?: 'PENDING' | 'CONFIRMED' | 'COMPLETED' | 'CANCELLED' | 'NO_SHOW';
    atVenueId?: string;
  } = {},
) {
  return asAppSuperuser(db, async (tx) => {
    const resource = await tx.resource.create({
      data: {
        tenantId: tenant.tenantId,
        venueId: opts.atVenueId ?? venueId,
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
        bookedByUserId: opts.userId ?? tenant.userId,
        status: opts.status ?? 'COMPLETED',
        totalCents: 2400,
        idempotencyKey: `idem-${Math.random().toString(36).slice(2, 12)}`,
      },
    });
  });
}

// ══ Proof of visit ═══════════════════════════════════════════════════

describe('you can only review a venue you actually played at', () => {
  it('accepts a review backed by a COMPLETED booking', async () => {
    const booking = await seedBooking();

    const r = await review({ bookingId: booking.id, body: 'Excellent courts.' });

    expect(r.status).toBe('PUBLISHED');
    expect(r).toMatchObject({ bookingId: booking.id, venueId, rating: 5 });
  });

  it('REFUSES a review from someone with no booking at all', async () => {
    // Without this check the review box is an open comment field, and a rival
    // club can leave one-stars from a burner account.
    await expect(
      review({ bookingId: 'bk_does_not_exist', authorUserId: otherUserId, rating: 1 }),
    ).rejects.toThrow(NoProofOfVisitError);

    expect(await db.review.count({ where: { venueId } })).toBe(0);
  });

  it("REFUSES a review against SOMEONE ELSE'S booking", async () => {
    const booking = await seedBooking({ userId: tenant.userId });

    // The stranger points at a real, completed booking — just not theirs.
    await expect(
      review({ bookingId: booking.id, authorUserId: otherUserId, rating: 1 }),
    ).rejects.toThrow(NoProofOfVisitError);
  });

  it.each(['PENDING', 'CONFIRMED', 'CANCELLED', 'NO_SHOW'] as const)(
    'REFUSES a %s booking — only COMPLETED proves a visit',
    async (status) => {
      // PENDING is the sneaky one: it costs nothing to create and nothing to
      // abandon — book, review, cancel, repeat. CONFIRMED has not been played
      // yet. NO_SHOW is staff saying it never was.
      const booking = await seedBooking({ status });

      await expect(review({ bookingId: booking.id })).rejects.toThrow(NoProofOfVisitError);
    },
  );

  it('REFUSES a booking at ANOTHER club, even one the author holds', async () => {
    // The runner binds OUR club, so RLS hides theirs: the booking cannot be
    // found, and "not found" is exactly what proof of visit reports.
    const elsewhere = await seedTenant();
    const theirVenue = await asAppSuperuser(db, (tx) =>
      tx.venue.create({
        data: {
          tenantId: elsewhere.tenantId,
          name: 'Elsewhere',
          slug: `elsewhere-${Math.random().toString(36).slice(2, 10)}`,
          city: 'Plovdiv',
          addressLine: '1 Main St',
          lat: 42.15,
          lng: 24.75,
          email: 'e@playerz.test',
        },
      }),
    );
    const theirBooking = await asAppSuperuser(db, async (tx) => {
      const court = await tx.resource.create({
        data: {
          tenantId: elsewhere.tenantId,
          venueId: theirVenue.id,
          name: 'Court',
          sport: 'PADEL',
          surface: 'HARD',
          basePriceCents: 2000,
        },
      });
      return tx.booking.create({
        data: {
          tenantId: elsewhere.tenantId,
          resourceId: court.id,
          startTs: new Date(Date.now() - 2 * HOUR),
          endTs: new Date(Date.now() - HOUR),
          bookedByUserId: tenant.userId,
          status: 'COMPLETED',
          totalCents: 2000,
          idempotencyKey: `other-${Math.random()}`,
        },
      });
    });

    await expect(review({ bookingId: theirBooking.id })).rejects.toThrow(NoProofOfVisitError);
  });

  it('lands on the booking’s OWN venue — there is no other venue to point it at', async () => {
    // The old check was "the booking is at the venue being reviewed". The venue
    // is now DERIVED from the booking, so "book a cheap court at A and review
    // B" is not a check that could be forgotten; it is not expressible.
    const cheap = await seedVenue('Cheap Courts');
    const booking = await seedBooking({ atVenueId: cheap.id });

    const r = await review({ bookingId: booking.id, rating: 1 });

    expect(r.venueId).toBe(cheap.id);
    expect((await venueScore()).reviewCount).toBe(0);
  });

  it('refuses a rating that is not a whole number from 1 to 5, before anything else', async () => {
    const booking = await seedBooking();

    for (const rating of [0, 6, 4.5, Number.NaN]) {
      await expect(review({ bookingId: booking.id, rating })).rejects.toThrow(InvalidRatingError);
    }
    expect(await db.review.count({ where: { venueId } })).toBe(0);
  });

  it('the DATABASE refuses a 0- or 6-star rating, not just the app', async () => {
    const booking = await seedBooking();

    const attempt = asAppSuperuser(db, (tx) =>
      tx.review.create({
        data: {
          tenantId: tenant.tenantId,
          venueId,
          authorUserId: tenant.userId,
          bookingId: booking.id,
          rating: 6,
        },
      }),
    );

    await expect(attempt.catch((e) => pgErrorCode(e))).resolves.toBe('23514');
  });
});

// ══ One review per venue ═════════════════════════════════════════════

describe('one review per venue per person', () => {
  it('one booking is worth exactly ONE review', async () => {
    const booking = await seedBooking();
    await review({ bookingId: booking.id });

    await expect(review({ bookingId: booking.id })).rejects.toThrow(AlreadyReviewedError);
  });

  it('a second completed visit is REFUSED, and the first review is untouched', async () => {
    // The owner's open question: block, or edit and re-moderate. Blocked — see
    // AlreadyReviewedError for why an edit is its own change.
    const first = await seedBooking();
    const second = await seedBooking();
    const original = await review({ bookingId: first.id, rating: 4, body: 'Good first visit.' });

    await expect(
      review({ bookingId: second.id, rating: 1, body: 'Second visit was worse.' }),
    ).rejects.toThrow(AlreadyReviewedError);

    const stored = await db.review.findMany({ where: { venueId } });
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ id: original.id, bookingId: first.id, rating: 4 });
  });

  it('a second visit does not even reach the classifier', async () => {
    // Refused BEFORE moderation, which costs tokens. A refusal should not.
    const first = await seedBooking();
    const second = await seedBooking();
    await review({ bookingId: first.id });
    const before = classifierCalls();

    await expect(
      review({ bookingId: second.id, body: 'text that would cost a call' }),
    ).rejects.toThrow(AlreadyReviewedError);

    expect(classifierCalls()).toBe(before);
  });

  it('two visits reviewed AT ONCE: exactly one wins, and the other is told why', async () => {
    // Both pass the check before either has written. The unique index on
    // (venueId, authorUserId) arbitrates, and the loser gets AlreadyReviewed,
    // not a 23505 surfacing as a 500.
    const a = await seedBooking();
    const b = await seedBooking();

    const results = await Promise.allSettled([
      review({ bookingId: a.id, rating: 5 }),
      review({ bookingId: b.id, rating: 2 }),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const lost = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(lost.reason).toBeInstanceOf(AlreadyReviewedError);
    expect(await db.review.count({ where: { venueId } })).toBe(1);
    expect((await venueScore()).reviewCount).toBe(1);
  });

  it('the database still refuses a second review of one booking, underneath the check', async () => {
    const booking = await seedBooking();
    await review({ bookingId: booking.id });

    const direct = asAppSuperuser(db, (tx) =>
      tx.review.create({
        data: {
          tenantId: tenant.tenantId,
          venueId,
          authorUserId: otherUserId,
          bookingId: booking.id,
          rating: 1,
        },
      }),
    );

    await expect(direct.catch((e) => pgErrorCode(e))).resolves.toBe('23505');
  });
});

// ══ Moderation ═══════════════════════════════════════════════════════

describe('nothing is visible until it has been moderated', () => {
  it('a flagged review is held as PENDING_REVIEW and opens a case', async () => {
    setModerationScores({ harassment: 0.6 });
    const booking = await seedBooking();

    const r = await review({ bookingId: booking.id, rating: 1, body: 'something flagged' });

    expect(r.status).toBe('PENDING_REVIEW');

    const c = await db.moderationCase.findFirstOrThrow({
      where: { subjectType: 'REVIEW', subjectId: r.id },
    });
    expect(c.status).toBe('OPEN');
    expect(c.reason).toBe('harassment');
    expect(c.tenantId).toBe(tenant.tenantId);
  });

  it('a PENDING review does NOT move the venue score', async () => {
    // A one-star nobody has verified must not drag the average down while a
    // human is still deciding whether it is real.
    setModerationScores({ harassment: 0.6 });
    const booking = await seedBooking();

    await review({ bookingId: booking.id, rating: 1, body: 'held for review' });

    expect((await venueScore()).reviewCount).toBe(0);
  });

  it('an auto-REJECTED review still opens a case — an automated decision nobody can appeal is not acceptable', async () => {
    setModerationScores({ 'sexual/minors': 0.9 });
    const booking = await seedBooking();

    const r = await review({ bookingId: booking.id, rating: 1, body: 'auto-rejected content' });

    expect(r.status).toBe('REJECTED');

    // The case exists, so "why was my review taken down?" has an answer.
    const c = await db.moderationCase.findFirstOrThrow({
      where: { subjectType: 'REVIEW', subjectId: r.id },
    });
    expect(c.reason).toBe('sexual/minors');
  });

  it('a classifier OUTAGE queues the review — it does not publish it', async () => {
    // If an outage defaulted to publishing, the way to get anything onto the
    // site would be to attack our moderation provider.
    const key = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;

    try {
      const booking = await seedBooking();

      const r = await review({ bookingId: booking.id, body: 'anything at all' });

      expect(r.status).toBe('PENDING_REVIEW');
      const c = await db.moderationCase.findFirstOrThrow({ where: { subjectId: r.id } });
      expect(c.reason).toBe('classifier_unavailable');
    } finally {
      if (key !== undefined) process.env.ANTHROPIC_API_KEY = key;
    }
  });

  it('a star-only review with no text is published without calling the classifier', async () => {
    const booking = await seedBooking();
    const before = classifierCalls();

    const r = await review({ bookingId: booking.id, rating: 4, body: '   ' });

    expect(r.status).toBe('PUBLISHED');
    expect(r.body).toBeNull();
    expect(classifierCalls()).toBe(before);
  });

  it('text is classified OUTSIDE any transaction', async () => {
    // The classifier has a ten-second timeout. Inside a transaction that is a
    // pooled connection held idle, and past Prisma's five-second limit the
    // write fails on a closed transaction after the classifier has answered.
    // The runner is instrumented, so this fails if the call ever moves inside.
    const booking = await seedBooking();
    let open = 0;
    let classifiedInside: boolean | null = null;

    const counting: TenantRunner = async (fn) => {
      open += 1;
      try {
        return await asAppUser(db, tenant.tenantId, fn);
      } finally {
        open -= 1;
      }
    };

    await createReview(
      counting,
      {
        tenantId: tenant.tenantId,
        bookingId: booking.id,
        authorUserId: tenant.userId,
        rating: 5,
        body: 'classify me',
      },
      async () => {
        classifiedInside = open > 0;
        return { decision: 'APPROVED', maxScore: 0, reason: null, scores: {} };
      },
    );

    expect(classifiedInside).toBe(false);
  });

  it('the body is sanitised on the way in', async () => {
    const booking = await seedBooking();

    const r = await review({
      bookingId: booking.id,
      body: 'Great <script>alert(1)</script>courts',
    });

    expect(r.body).not.toContain('<script>');
    const stored = await db.review.findUniqueOrThrow({ where: { id: r.id } });
    expect(stored.body).toBe(r.body);
  });

  it('a moderator publishing a held review MOVES the score', async () => {
    setModerationScores({ harassment: 0.6 });
    const booking = await seedBooking();

    const r = await review({ bookingId: booking.id, body: 'held, then approved' });
    expect((await venueScore()).reviewCount).toBe(0);

    const c = await db.moderationCase.findFirstOrThrow({ where: { subjectId: r.id } });
    await resolveCase(db, { caseId: c.id, moderatorUserId: tenant.userId, approve: true });

    // If the score did not move, moderation would have no effect on the thing
    // reviews exist to produce.
    expect((await venueScore()).reviewCount).toBe(1);
    const stored = await db.review.findUniqueOrThrow({ where: { id: r.id } });
    expect(stored.status).toBe('PUBLISHED');
  });

  it('a moderator rejecting a published review REMOVES it from the score', async () => {
    const booking = await seedBooking();
    const r = await review({ bookingId: booking.id, body: 'published, then taken down' });
    expect(r.status).toBe('PUBLISHED');

    const { caseId } = await reportContent(db, {
      tenantId: tenant.tenantId,
      subjectType: 'REVIEW',
      subjectId: r.id,
      reporterUserId: otherUserId,
      reason: 'fake review',
    });

    await resolveCase(db, { caseId, moderatorUserId: tenant.userId, approve: false });

    expect((await venueScore()).reviewCount).toBe(0);
  });
});

// ══ A review and a no-show, racing ═══════════════════════════════════

/**
 * A gate for holding one transaction open, uncommitted, while another runs.
 *
 * Racing two promises and hoping they interleave proves nothing: measured, a
 * race test for the venue lock passed three runs out of three with the lock
 * deleted. These tests FORCE the interleaving that the locks exist for, so
 * deleting a lock fails them every time.
 */
function gate() {
  let open!: () => void;
  let arrive!: () => void;
  const opened = new Promise<void>((r) => (open = r));
  const arrived = new Promise<void>((r) => (arrive = r));
  return { open, opened, arrive, arrived };
}

/** Long enough for a blocked statement to be sitting on its lock. */
const settle = () => new Promise((r) => setTimeout(r, 300));

const statusOf = (bookingId: string) =>
  asAppSuperuser(db, (tx) =>
    tx.booking.findUniqueOrThrow({ where: { id: bookingId } }).then((b) => b.status),
  );

describe('a review and a no-show for the same booking', () => {
  it('a no-show still uncommitted when the review arrives wins, and the review is refused', async () => {
    // Without the lock in createReview, the review reads COMPLETED (the
    // no-show has not committed), writes, and commits first — leaving a
    // NO_SHOW booking with a review hanging off it.
    const booking = await seedBooking();
    const g = gate();

    const marking = asAppUser(db, tenant.tenantId, async (tx) => {
      await markNoShow(tx, tenant.tenantId, { bookingId: booking.id, actorUserId: tenant.userId });
      g.arrive();
      await g.opened;
    });
    await g.arrived;

    const reviewing = review({ bookingId: booking.id }).then(
      () => 'reviewed',
      (e: unknown) => e,
    );
    await settle();
    g.open();

    await marking;
    expect(await reviewing).toBeInstanceOf(NoProofOfVisitError);
    expect(await statusOf(booking.id)).toBe('NO_SHOW');
    expect(await db.review.count({ where: { bookingId: booking.id } })).toBe(0);
  });

  it('a review still uncommitted when the no-show arrives wins, and the no-show is refused', async () => {
    // The mirror image, which is markNoShow's own lock: without it, staff read
    // "no review yet" through the uncommitted insert and mark the booking
    // NO_SHOW underneath a review that then commits.
    const booking = await seedBooking();
    const g = gate();
    let calls = 0;

    // Holds the SECOND transaction — the write — open after the review row
    // exists, before it commits.
    const holding: TenantRunner = (fn) =>
      asAppUser(db, tenant.tenantId, async (tx) => {
        const result = await fn(tx);
        if (++calls === 2) {
          g.arrive();
          await g.opened;
        }
        return result;
      });

    const reviewing = createReview(holding, {
      tenantId: tenant.tenantId,
      bookingId: booking.id,
      authorUserId: tenant.userId,
      rating: 5,
    });
    await g.arrived;

    const marking = asAppUser(db, tenant.tenantId, (tx) =>
      markNoShow(tx, tenant.tenantId, { bookingId: booking.id, actorUserId: tenant.userId }),
    ).then(
      () => 'marked',
      (e: unknown) => e,
    );
    await settle();
    g.open();

    await reviewing;
    const refused = await marking;
    expect(refused).toBeInstanceOf(NoShowRefusedError);
    expect((refused as NoShowRefusedError).reason).toBe('REVIEWED');
    expect(await statusOf(booking.id)).toBe('COMPLETED');
  });
});

// ══ Reporting ════════════════════════════════════════════════════════

describe('reporting', () => {
  it('ten people reporting one review is ONE job for a moderator', async () => {
    const booking = await seedBooking();
    const r = await review({ bookingId: booking.id, body: 'a contested review' });

    const reporters = await asAppSuperuser(db, (tx) =>
      Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          tx.user.create({
            data: { email: `reporter-${i}-${Math.random().toString(36).slice(2, 8)}@playerz.test` },
          }),
        ),
      ),
    );

    const cases = await Promise.all(
      reporters.map((u) =>
        reportContent(db, {
          tenantId: tenant.tenantId,
          subjectType: 'REVIEW',
          subjectId: r.id,
          reporterUserId: u.id,
          reason: 'spam',
        }),
      ),
    );

    // One case, not ten. Otherwise a coordinated group buries the queue in
    // duplicates of a single item and everything else in it goes unlooked-at.
    const openCases = await db.moderationCase.count({
      where: { subjectId: r.id, status: 'OPEN' },
    });
    expect(openCases).toBe(1);
    expect(new Set(cases.map((c) => c.caseId)).size).toBe(1);

    // But all ten reports are on the record — that is how brigading is spotted.
    expect(await db.contentReport.count({ where: { subjectId: r.id } })).toBe(10);
  });

  it('one person cannot manufacture a consensus by reporting ten times', async () => {
    const booking = await seedBooking();
    const r = await review({ bookingId: booking.id, body: 'a review' });

    for (let i = 0; i < 10; i++) {
      await reportContent(db, {
        tenantId: tenant.tenantId,
        subjectType: 'REVIEW',
        subjectId: r.id,
        reporterUserId: otherUserId,
        reason: 'spam',
      });
    }

    expect(await db.contentReport.count({ where: { subjectId: r.id } })).toBe(1);
  });

  it('a subject can be reported AGAIN after an earlier case was resolved', async () => {
    // The bug the partial index exists to avoid: a plain
    // UNIQUE(subjectType, subjectId, status) permits only one RESOLVED case
    // per subject, so the moderator's SECOND decision on an item would violate
    // it and they would get a 500 for doing their job.
    const booking = await seedBooking();
    const r = await review({ bookingId: booking.id, body: 'a review' });

    const first = await reportContent(db, {
      tenantId: tenant.tenantId,
      subjectType: 'REVIEW',
      subjectId: r.id,
      reporterUserId: otherUserId,
      reason: 'spam',
    });
    await resolveCase(db, { caseId: first.caseId, moderatorUserId: tenant.userId, approve: true });

    // Someone else reports it later. This must OPEN A NEW CASE, not explode.
    const second = await reportContent(db, {
      tenantId: tenant.tenantId,
      subjectType: 'REVIEW',
      subjectId: r.id,
      reporterUserId: tenant.userId,
      reason: 'still spam',
    });

    expect(second.caseId).not.toBe(first.caseId);

    await resolveCase(db, {
      caseId: second.caseId,
      moderatorUserId: tenant.userId,
      approve: false,
    });

    const resolved = await db.moderationCase.count({
      where: { subjectId: r.id, status: { in: ['APPROVED', 'REJECTED'] } },
    });
    expect(resolved).toBe(2);
  });
});

// ══ The score ════════════════════════════════════════════════════════

describe('the venue score', () => {
  it('is recomputed from the full set, so a taken-down review really leaves', async () => {
    // Recomputing rather than incrementally adjusting is what makes moderation
    // repairable. An incremental average has no way to un-add a review.
    const ratings = [5, 5, 1];
    for (const rating of ratings) {
      const booking = await seedBooking();
      await asAppSuperuser(db, (tx) =>
        tx.review.create({
          data: {
            tenantId: tenant.tenantId,
            venueId,
            // A distinct author per review, since @@unique([venueId,
            // authorUserId]) allows only one each.
            authorUserId: `user-${Math.random().toString(36).slice(2, 10)}`,
            bookingId: booking.id,
            rating,
            status: 'PUBLISHED',
          },
        }),
      );
    }

    const { reviewCount, avgRating } = await recomputeVenueRating(db, {
      tenantId: tenant.tenantId,
      venueId,
    });

    expect(reviewCount).toBe(3);
    // Bayesian: (10*4 + 11) / 13 = 3.9 — NOT the naive mean of 3.67.
    expect(avgRating).toBeCloseTo(3.9, 1);
  });

  it('a published review moves avgRating and reviewCount on the venue the list reads', async () => {
    const booking = await seedBooking();

    await review({ bookingId: booking.id, rating: 5 });

    // One 5-star review is 4.1, not 5.0 — see score.ts on why one friendly
    // review must not outrank a venue with a track record.
    expect(await venueScore()).toEqual({ avgRating: 4.1, reviewCount: 1 });
  });

  it('a venue whose only review is taken down reads 0, not the Bayesian prior', async () => {
    // bayesianAverageFromTotals(0, 0) is 4.0 — the prior. Written back, a venue
    // nobody had rated would print "4.0 ★", and differ from a never-reviewed
    // venue, which the column leaves at 0. The v1 contract says 0.
    const booking = await seedBooking();
    const r = await review({ bookingId: booking.id, rating: 5 });
    const { caseId } = await reportContent(db, {
      tenantId: tenant.tenantId,
      subjectType: 'REVIEW',
      subjectId: r.id,
      reporterUserId: otherUserId,
      reason: 'fake',
    });

    await resolveCase(db, { caseId, moderatorUserId: tenant.userId, approve: false });

    expect(await venueScore()).toEqual({ avgRating: 0, reviewCount: 0 });
  });

  it('two reviews published at once are BOTH counted', async () => {
    // Without the venue row lock, the second recompute aggregates a snapshot
    // that cannot see the first's uncommitted row, waits for the first to
    // commit only at its UPDATE, and then writes a count that is one short —
    // for good, at a club where nobody else reviews. The first transaction is
    // held open to force exactly that interleaving.
    const publish = (tx: PrismaClient, rating: number) =>
      tx.review
        .create({
          data: {
            tenantId: tenant.tenantId,
            venueId,
            authorUserId: `author-${Math.random().toString(36).slice(2, 10)}`,
            rating,
            status: 'PUBLISHED',
          },
        })
        .then(() => recomputeVenueRating(tx, { tenantId: tenant.tenantId, venueId }));

    const g = gate();
    const first = asAppUser(db, tenant.tenantId, async (tx) => {
      await publish(tx, 5);
      g.arrive();
      await g.opened;
    });
    await g.arrived;

    const second = asAppUser(db, tenant.tenantId, (tx) => publish(tx, 3));
    await settle();
    g.open();
    await Promise.all([first, second]);

    // (10 × 4.0 + 5 + 3) / 12 = 4.0
    expect(await venueScore()).toEqual({ avgRating: 4, reviewCount: 2 });
  });
});
