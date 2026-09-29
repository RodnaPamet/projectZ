import { randomUUID } from 'node:crypto';

import { PlatformCapability } from '@prisma/client';
import { encode } from 'next-auth/jwt';
import { NextRequest } from 'next/server';

import { GET as listRoute } from '@/app/api/v1/platform/moderation/cases/route';
import { POST as resolveRoute } from '@/app/api/v1/platform/moderation/cases/[id]/resolve/route';
import { createReview, reportContent } from '@/app-layer/usecases/reviews';
import { createUserSession, newSessionSecret } from '@/lib/auth/sessions';

import { seedPlayer } from '../helpers/auth';
import { prismaTestClient, seedTenant, type SeededTenant } from '../helpers/db';
import { setModerationScores, useMswServer } from '../helpers/msw';
import { asAppSuperuser, asAppUser } from '../helpers/rls';

/**
 * The review moderation queue, through the real platform routes.
 *
 * What has to be true, in the owner's words: platform admins see OPEN review
 * cases with the text and the classifier's scores; approve publishes the review
 * and recomputes the venue's rating; reject hides it; the case closes either
 * way. And, because this is the first cross-club WRITE: nobody without
 * REVIEW_MODERATE gets in, and nothing happens without an audit row first.
 *
 * The classifier is MSW-mocked here as everywhere — never the real API.
 */

const REASON = 'review moderation shift 2026-09-29';
const NOTE = 'honest criticism of the club, not abuse';
const HOUR = 3_600_000;

const db = prismaTestClient();

useMswServer();

let admin: string;
let granter: string;
let clubs: Array<{ tenant: SeededTenant; venueId: string }>;

type Item = {
  caseId: string;
  reason: string;
  openedAt: string;
  scores: Record<string, number>;
  review: { id: string; rating: number; body: string | null; status: string; createdAt: string };
  venue: { id: string; name: string };
  club: { id: string; slug: string; name: string };
};
type Page = { data: { items: Item[]; nextCursor: string | null } };
type ApiError = { error: { code: string } };

const uid = (prefix: string) => `${prefix}${randomUUID().replace(/-/g, '').slice(0, 21)}`;

beforeEach(async () => {
  // A moderator who belongs to NEITHER club — "saw club A's case" would prove
  // nothing if they were a member of club A.
  admin = uid('cadm');
  granter = uid('cgrn');
  await asAppSuperuser(db, (tx) =>
    tx.$executeRawUnsafe(
      `INSERT INTO app_user (id,email,"createdAt","updatedAt")
       VALUES ($1,$2,now(),now()), ($3,$4,now(),now())`,
      admin,
      `${admin}@test.invalid`,
      granter,
      `${granter}@test.invalid`,
    ),
  );

  clubs = [];
  for (const name of ['Club Alpha', 'Club Beta']) {
    const tenant = await seedTenant({ name });
    const venueId = await asAppSuperuser(db, (tx) =>
      tx.venue
        .create({
          data: {
            tenantId: tenant.tenantId,
            slug: `v-${Math.random().toString(36).slice(2, 10)}`,
            name: `${name} Courts`,
            addressLine: '1 Court St',
            city: 'Sofia',
            lat: 42.6977,
            lng: 23.3219,
            email: 'desk@club.test',
          },
        })
        .then((v) => v.id),
    );
    clubs.push({ tenant, venueId });
  }
});

/** A live grant for the admin carrying exactly `caps`. */
async function grant(caps: PlatformCapability[]) {
  await asAppSuperuser(db, (tx) =>
    tx.$executeRawUnsafe(
      `INSERT INTO platform_admin_grant
         (id,"userId","grantedByUserId",reason,capabilities,"expiresAt")
       VALUES ($1,$2,$3,'review moderation rota',$4::"PlatformCapability"[], now() + interval '7 days')`,
      uid('cg'),
      admin,
      granter,
      `{${caps.join(',')}}`,
    ),
  );
}

/** A Bearer token the way /auth/token mints one. */
async function bearerFor(userId: string) {
  const { userSessionId, sessionVersion } = await createUserSession({
    userId,
    sessionSecret: newSessionSecret(),
    expiresAt: new Date(Date.now() + HOUR),
  });
  return encode({
    secret: process.env.NEXTAUTH_SECRET!,
    maxAge: 900,
    token: { sub: userId, userSessionId, sessionVersion },
  });
}

/** A real review, through createReview, at club `i` — held if `flag` is set. */
async function reviewAt(i: number, opts: { rating?: number; body?: string; flag?: boolean } = {}) {
  const { tenant, venueId } = clubs[i]!;
  const author = await seedPlayer(db, tenant.tenantId, 'author');
  const booking = await asAppSuperuser(db, async (tx) => {
    const court = await tx.resource.create({
      data: {
        tenantId: tenant.tenantId,
        venueId,
        name: 'Court',
        sport: 'PADEL',
        surface: 'HARD',
        basePriceCents: 2400,
      },
    });
    return tx.booking.create({
      data: {
        tenantId: tenant.tenantId,
        resourceId: court.id,
        startTs: new Date(Date.now() - 2 * HOUR),
        endTs: new Date(Date.now() - HOUR),
        bookedByUserId: author,
        status: 'COMPLETED',
        totalCents: 2400,
        idempotencyKey: `m-${Math.random()}`,
      },
    });
  });

  if (opts.flag) setModerationScores({ harassment: 0.72, spam: 0.05 });
  const r = await createReview((fn) => asAppUser(db, tenant.tenantId, fn), {
    tenantId: tenant.tenantId,
    bookingId: booking.id,
    authorUserId: author,
    rating: opts.rating ?? 2,
    body: opts.body,
  });
  const openCase = await asAppSuperuser(db, (tx) =>
    tx.moderationCase.findFirst({ where: { subjectId: r.id, status: 'OPEN' } }),
  );
  return { reviewId: r.id, caseId: openCase?.id ?? null, status: r.status };
}

async function list(bearer: string | null, params: Record<string, string> = { reason: REASON }) {
  const qs = new URLSearchParams(params).toString();
  const res = await listRoute(
    new NextRequest(`http://t/api/v1/platform/moderation/cases?${qs}`, {
      headers: bearer ? { authorization: `Bearer ${bearer}` } : {},
    }),
    {},
  );
  return { status: res.status, json: (await res.json()) as unknown };
}

async function resolve(bearer: string | null, caseId: string, body: unknown) {
  const res = await resolveRoute(
    new NextRequest(`http://t/api/v1/platform/moderation/cases/${caseId}/resolve`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: caseId }) },
  );
  return { status: res.status, json: (await res.json()) as unknown };
}

const code = (json: unknown) => (json as ApiError).error.code;

const auditRows = () =>
  asAppSuperuser(db, (tx) =>
    tx.platformAuditEntry.findMany({
      orderBy: { createdAt: 'asc' },
      select: {
        action: true,
        capability: true,
        reason: true,
        actorUserId: true,
        entity: true,
        entityId: true,
      },
      take: 100,
    }),
  );

const venueScore = (i: number) =>
  asAppSuperuser(db, (tx) =>
    tx.venue.findUniqueOrThrow({
      where: { id: clubs[i]!.venueId },
      select: { avgRating: true, reviewCount: true },
    }),
  ).then((v) => ({ avgRating: Number(v.avgRating), reviewCount: v.reviewCount }));

// ══ Reading the queue ════════════════════════════════════════════════

describe('GET /api/v1/platform/moderation/cases', () => {
  it('shows open review cases from EVERY club, oldest first, with the text and the scores', async () => {
    await grant([PlatformCapability.REVIEW_MODERATE]);
    const first = await reviewAt(0, { flag: true, body: 'the owner is a thief' });
    const second = await reviewAt(1, { flag: true, body: 'worst club in Sofia' });

    const { status, json } = await list(await bearerFor(admin));

    expect(status).toBe(200);
    const { items, nextCursor } = (json as Page).data;
    expect(items.map((i) => i.caseId)).toEqual([first.caseId, second.caseId]);
    expect(nextCursor).toBeNull();
    // Two clubs in one answer is what proves the read crossed them.
    expect(items.map((i) => i.club.slug)).toEqual([
      clubs[0]!.tenant.tenantSlug,
      clubs[1]!.tenant.tenantSlug,
    ]);
    expect(items[0]).toMatchObject({
      reason: 'harassment',
      review: { id: first.reviewId, body: 'the owner is a thief', status: 'PENDING_REVIEW' },
      venue: { id: clubs[0]!.venueId },
    });
    expect(items[0]!.scores).toMatchObject({ harassment: 0.72, spam: 0.05 });
    // No author on the wire: the decision must not depend on who wrote it.
    expect(JSON.stringify(items[0])).not.toMatch(/author/i);
  });

  it('shows a review held because the classifier was DOWN, with no scores', async () => {
    await grant([PlatformCapability.REVIEW_MODERATE]);
    const key = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    const held = await reviewAt(0, { body: 'text nobody classified' }).finally(() => {
      if (key !== undefined) process.env.ANTHROPIC_API_KEY = key;
    });

    const { json } = await list(await bearerFor(admin));

    const [item] = (json as Page).data.items;
    expect(item).toMatchObject({
      caseId: held.caseId,
      reason: 'classifier_unavailable',
      scores: {},
    });
  });

  it('leaves out decided cases and cases that are not about a review', async () => {
    await grant([PlatformCapability.REVIEW_MODERATE]);
    const open = await reviewAt(0, { flag: true, body: 'still open' });
    const decided = await reviewAt(1, { flag: true, body: 'already decided' });
    await asAppSuperuser(db, (tx) =>
      tx.moderationCase.update({ where: { id: decided.caseId! }, data: { status: 'REJECTED' } }),
    );
    await asAppSuperuser(db, (tx) =>
      tx.moderationCase.create({
        data: {
          tenantId: null,
          subjectType: 'CHAT_MESSAGE',
          subjectId: 'msg_1',
          reason: 'user_report',
        },
      }),
    );

    const { json } = await list(await bearerFor(admin));

    expect((json as Page).data.items.map((i) => i.caseId)).toEqual([open.caseId]);
  });

  it('writes an audit row for every page, with the reason the moderator gave', async () => {
    await grant([PlatformCapability.REVIEW_MODERATE]);
    await reviewAt(0, { flag: true, body: 'x' });

    await list(await bearerFor(admin));

    expect(await auditRows()).toEqual([
      expect.objectContaining({
        action: 'PLATFORM_MODERATION_QUEUE_READ',
        capability: 'REVIEW_MODERATE',
        reason: REASON,
        actorUserId: admin,
      }),
    ]);
  });

  it('pages oldest first, never repeats a case, and refuses a cursor that names nothing', async () => {
    await grant([PlatformCapability.REVIEW_MODERATE]);
    // 51 cases: one more than a page. Written directly — the paging, not the
    // review path, is what is under test.
    const t0 = Date.now() - 10 * HOUR;
    await asAppSuperuser(db, async (tx) => {
      for (let i = 0; i < 51; i++) {
        const review = await tx.review.create({
          data: {
            tenantId: clubs[i % 2]!.tenant.tenantId,
            venueId: clubs[i % 2]!.venueId,
            authorUserId: `author-${i}`,
            rating: 3,
            body: `review ${i}`,
            status: 'PENDING_REVIEW',
          },
        });
        await tx.moderationCase.create({
          data: {
            tenantId: clubs[i % 2]!.tenant.tenantId,
            subjectType: 'REVIEW',
            subjectId: review.id,
            reason: 'harassment',
            // Ties on purpose: ten cases share each timestamp, which is what
            // makes a cursor without an id tiebreak skip rows.
            createdAt: new Date(t0 + Math.floor(i / 10) * 60_000),
          },
        });
      }
    });
    const bearer = await bearerFor(admin);

    const one = (await list(bearer)).json as Page;
    expect(one.data.items).toHaveLength(50);
    expect(one.data.nextCursor).not.toBeNull();

    const two = (await list(bearer, { reason: REASON, cursor: one.data.nextCursor! })).json as Page;
    expect(two.data.items).toHaveLength(1);
    expect(two.data.nextCursor).toBeNull();

    const ids = [...one.data.items, ...two.data.items].map((i) => i.caseId);
    expect(new Set(ids).size).toBe(51);
    const opened = [...one.data.items, ...two.data.items].map((i) => i.openedAt);
    expect([...opened].sort()).toEqual(opened);

    const unknown = await list(bearer, { reason: REASON, cursor: 'cnosuchcase00000000000' });
    expect(unknown.status).toBe(400);
    expect(code(unknown.json)).toBe('INVALID_CURSOR');
  });

  it('needs REVIEW_MODERATE — a TENANT_READ grant is refused, and leaves no row', async () => {
    await grant([PlatformCapability.TENANT_READ, PlatformCapability.AUDIT_READ]);
    await reviewAt(0, { flag: true, body: 'x' });

    const { status, json } = await list(await bearerFor(admin));

    expect(status).toBe(403);
    expect(code(json)).toBe('PLATFORM_CAPABILITY_REQUIRED');
    expect(await auditRows()).toEqual([]);
  });

  it('refuses a signed-in user with no grant, and an anonymous caller', async () => {
    const nobody = await list(await bearerFor(admin));
    expect(nobody.status).toBe(403);
    expect(code(nobody.json)).toBe('PLATFORM_AUTHORITY_REQUIRED');

    const anonymous = await list(null);
    expect(anonymous.status).toBe(401);
  });

  it('needs a stated reason — checked BEFORE authority, so it cannot probe for a grant', async () => {
    // No grant at all: a 400 rather than a 403 is the point.
    const { status, json } = await list(await bearerFor(admin), { reason: 'looking' });

    expect(status).toBe(400);
    expect(code(json)).toBe('REASON_REQUIRED');
  });
});

// ══ Deciding ═════════════════════════════════════════════════════════

describe('POST /api/v1/platform/moderation/cases/:id/resolve', () => {
  it('APPROVE publishes the review, closes the case with the note, and moves the rating', async () => {
    await grant([PlatformCapability.REVIEW_MODERATE]);
    const held = await reviewAt(0, { rating: 5, flag: true, body: 'rude staff but great courts' });
    expect(await venueScore(0)).toEqual({ avgRating: 0, reviewCount: 0 });

    const { status, json } = await resolve(await bearerFor(admin), held.caseId!, {
      decision: 'APPROVE',
      note: NOTE,
    });

    expect(status).toBe(200);
    expect(json).toEqual({
      data: {
        caseId: held.caseId,
        status: 'APPROVED',
        review: { id: held.reviewId, status: 'PUBLISHED' },
        venue: { id: clubs[0]!.venueId, avgRating: 4.1, reviewCount: 1 },
      },
    });

    // The venue list reads these columns: the approval reached it at once.
    expect(await venueScore(0)).toEqual({ avgRating: 4.1, reviewCount: 1 });
    const c = await asAppSuperuser(db, (tx) =>
      tx.moderationCase.findUniqueOrThrow({ where: { id: held.caseId! } }),
    );
    expect(c).toMatchObject({ status: 'APPROVED', resolvedByUserId: admin, resolutionNote: NOTE });
    expect(c.resolvedAt).not.toBeNull();
  });

  it('REJECT hides a reported live review and takes it out of the rating', async () => {
    await grant([PlatformCapability.REVIEW_MODERATE]);
    // Star-only, so published at once; then a player reports it.
    const live = await reviewAt(1, { rating: 1 });
    expect(live.status).toBe('PUBLISHED');
    expect(await venueScore(1)).toEqual({ avgRating: 3.7, reviewCount: 1 });
    const reporter = await seedPlayer(db, clubs[1]!.tenant.tenantId, 'reporter');
    const { caseId } = await reportContent(db, {
      tenantId: clubs[1]!.tenant.tenantId,
      subjectType: 'REVIEW',
      subjectId: live.reviewId,
      reporterUserId: reporter,
      reason: 'fake review from a rival',
    });

    const { status, json } = await resolve(await bearerFor(admin), caseId, {
      decision: 'REJECT',
      note: 'posted from a rival club, per the report',
    });

    expect(status).toBe(200);
    expect((json as { data: { review: { status: string } } }).data.review.status).toBe('REJECTED');
    // Back to 0, not the Bayesian prior of 4.0.
    expect(await venueScore(1)).toEqual({ avgRating: 0, reviewCount: 0 });
    const stored = await asAppSuperuser(db, (tx) =>
      tx.review.findUniqueOrThrow({ where: { id: live.reviewId } }),
    );
    // Hidden, not deleted: the text is kept.
    expect(stored).toMatchObject({ status: 'REJECTED', rating: 1 });
  });

  it('audits the decision before it takes effect, with the note as the reason', async () => {
    await grant([PlatformCapability.REVIEW_MODERATE]);
    const held = await reviewAt(0, { flag: true, body: 'x' });

    await resolve(await bearerFor(admin), held.caseId!, { decision: 'REJECT', note: NOTE });

    expect(await auditRows()).toEqual([
      {
        action: 'PLATFORM_REVIEW_REJECTED',
        capability: 'REVIEW_MODERATE',
        reason: NOTE,
        actorUserId: admin,
        entity: 'ModerationCase',
        entityId: held.caseId,
      },
    ]);
  });

  it('a second decision on one case is 409, and changes nothing', async () => {
    // Two moderators on one case. "Last click wins" would publish what the
    // first had just rejected, under a note describing the opposite.
    await grant([PlatformCapability.REVIEW_MODERATE]);
    const held = await reviewAt(0, { flag: true, body: 'x' });
    const bearer = await bearerFor(admin);
    await resolve(bearer, held.caseId!, { decision: 'REJECT', note: NOTE });

    const again = await resolve(bearer, held.caseId!, {
      decision: 'APPROVE',
      note: 'on second thoughts, publish it',
    });

    expect(again.status).toBe(409);
    expect(code(again.json)).toBe('CASE_ALREADY_RESOLVED');
    const stored = await asAppSuperuser(db, (tx) =>
      tx.review.findUniqueOrThrow({ where: { id: held.reviewId } }),
    );
    expect(stored.status).toBe('REJECTED');
    // The refused attempt rolled its audit row back with everything else.
    expect((await auditRows()).map((r) => r.action)).toEqual(['PLATFORM_REVIEW_REJECTED']);
  });

  it('an unknown case is 404, and leaves no row', async () => {
    await grant([PlatformCapability.REVIEW_MODERATE]);

    const { status, json } = await resolve(await bearerFor(admin), 'cnosuchcase00000000000', {
      decision: 'APPROVE',
      note: NOTE,
    });

    expect(status).toBe(404);
    expect(code(json)).toBe('CASE_NOT_FOUND');
    expect(await auditRows()).toEqual([]);
  });

  it('refuses a note too short to answer "why", and a decision that is neither', async () => {
    await grant([PlatformCapability.REVIEW_MODERATE]);
    const held = await reviewAt(0, { flag: true, body: 'x' });
    const bearer = await bearerFor(admin);

    const short = await resolve(bearer, held.caseId!, { decision: 'APPROVE', note: 'ok' });
    expect(short.status).toBe(400);
    expect(code(short.json)).toBe('REASON_REQUIRED');

    const neither = await resolve(bearer, held.caseId!, { decision: 'MAYBE', note: NOTE });
    expect(neither.status).toBe(400);

    const c = await asAppSuperuser(db, (tx) =>
      tx.moderationCase.findUniqueOrThrow({ where: { id: held.caseId! } }),
    );
    expect(c.status).toBe('OPEN');
  });

  it('needs REVIEW_MODERATE to decide too — TENANT_READ changes nothing', async () => {
    await grant([PlatformCapability.TENANT_READ]);
    const held = await reviewAt(0, { flag: true, body: 'x' });

    const { status, json } = await resolve(await bearerFor(admin), held.caseId!, {
      decision: 'APPROVE',
      note: NOTE,
    });

    expect(status).toBe(403);
    expect(code(json)).toBe('PLATFORM_CAPABILITY_REQUIRED');
    const c = await asAppSuperuser(db, (tx) =>
      tx.moderationCase.findUniqueOrThrow({ where: { id: held.caseId! } }),
    );
    expect(c.status).toBe('OPEN');
  });

  it('refuses an anonymous caller', async () => {
    const held = await reviewAt(0, { flag: true, body: 'x' });

    const { status } = await resolve(null, held.caseId!, { decision: 'APPROVE', note: NOTE });

    expect(status).toBe(401);
  });
});
