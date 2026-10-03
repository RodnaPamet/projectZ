import { randomUUID } from 'node:crypto';

import { PlatformCapability } from '@prisma/client';
import { NextRequest } from 'next/server';

import { POST as resolveRoute } from '@/app/api/v1/platform/moderation/cases/[id]/resolve/route';
import { POST as reviewRoute } from '@/app/api/v1/t/[slug]/bookings/[id]/review/route';
import { POST as createBookingRoute } from '@/app/api/v1/t/[slug]/bookings/route';
import { createReview } from '@/app-layer/usecases/reviews';

import { seedPlayer, signInAs, type TestIdentity } from '../helpers/auth';
import { prismaTestClient, seedTenant, type SeededTenant } from '../helpers/db';
import { enrolAndStepUp } from '../helpers/mfa';
import { setModerationScores, useMswServer } from '../helpers/msw';
import { asAppSuperuser, asAppUser } from '../helpers/rls';

/**
 * The two request checks (src/app/api/v1/_lib/request-guard.ts) through the
 * three writes the browser will make over v1 — a booking, a review, a
 * moderation decision — with a real session, a real cookie and a real database.
 *
 *   cookie + Sec-Fetch-Site: cross-site   → 403 CROSS_SITE_REQUEST, nothing written
 *   cookie + Sec-Fetch-Site: same-origin  → the write happens
 *   Bearer + Sec-Fetch-Site: cross-site   → the write happens (native is unaffected)
 *   x-playerz-viewer ≠ the signed-in user → 409 VIEWER_CHANGED, nothing written
 *
 * The cookie is the same JWE a Bearer header carries; `getToken` reads it as
 * `next-auth.session-token` because NEXTAUTH_URL is http in the test env.
 */

const db = prismaTestClient();
useMswServer();

const HOUR = 3_600_000;
const COOKIE = 'next-auth.session-token';

type Auth =
  | { kind: 'cookie'; who: TestIdentity; site?: string; viewer?: string }
  | { kind: 'bearer'; who: TestIdentity; site?: string; viewer?: string };

function headersFor(auth: Auth, extra: Record<string, string> = {}): Record<string, string> {
  const h: Record<string, string> = { 'content-type': 'application/json', ...extra };
  if (auth.kind === 'cookie') h.cookie = `${COOKIE}=${auth.who.bearer}`;
  else h.authorization = `Bearer ${auth.who.bearer}`;
  if (auth.site) h['sec-fetch-site'] = auth.site;
  if (auth.viewer) h['x-playerz-viewer'] = auth.viewer;
  return h;
}

const code = (json: unknown) => (json as { error?: { code?: string } }).error?.code;

let tenant: SeededTenant;
let player: TestIdentity;
let venueId: string;
let resourceId: string;

beforeEach(async () => {
  tenant = await seedTenant({});
  const seeded = await asAppSuperuser(db, async (tx) => {
    const venue = await tx.venue.create({
      data: {
        tenantId: tenant.tenantId,
        slug: `xs-club-${Math.random().toString(36).slice(2, 10)}`,
        name: 'Cross Club',
        addressLine: '1 Court St',
        city: 'Sofia',
        email: 'desk@club.test',
        lat: 42.6977,
        lng: 23.3219,
        timezone: 'Europe/Sofia',
      },
    });
    const resource = await tx.resource.create({
      data: {
        tenantId: tenant.tenantId,
        venueId: venue.id,
        name: 'Court 1',
        sport: 'PADEL',
        surface: 'HARD',
        basePriceCents: 2400,
        minBookingMinutes: 60,
        maxBookingMinutes: 180,
        slotStepMinutes: 60,
      },
    });
    await tx.resourceAvailability.create({
      data: {
        tenantId: tenant.tenantId,
        resourceId: resource.id,
        dayOfWeek: 3,
        openTime: new Date('1970-01-01T09:00:00Z'),
        closeTime: new Date('1970-01-01T17:00:00Z'),
      },
    });
    return { venue, resource };
  });
  venueId = seeded.venue.id;
  resourceId = seeded.resource.id;

  const playerId = await seedPlayer(db, tenant.tenantId);
  player = await signInAs(db, {
    userId: playerId,
    memberships: [{ tenantId: tenant.tenantId, tenantSlug: tenant.tenantSlug, role: 'PLAYER' }],
  });
});

// ══ POST /t/{slug}/bookings ══════════════════════════════════════════

describe('POST /api/v1/t/:slug/bookings', () => {
  // 2026-07-15 is a Wednesday; 09:00 Sofia = 06:00Z. Each case books its own hour.
  let hour = 6;
  const slot = () => {
    const h = hour++;
    const pad = (n: number) => String(n).padStart(2, '0');
    return { startTs: `2026-07-15T${pad(h)}:00:00Z`, endTs: `2026-07-15T${pad(h + 1)}:00:00Z` };
  };
  beforeEach(() => {
    hour = 6;
  });

  const book = async (auth: Auth) => {
    const res = await createBookingRoute(
      new NextRequest(`http://t/api/v1/t/${tenant.tenantSlug}/bookings`, {
        method: 'POST',
        headers: headersFor(auth, { 'idempotency-key': randomUUID() }),
        body: JSON.stringify({ resourceId, ...slot() }),
      }),
      { params: Promise.resolve({ slug: tenant.tenantSlug }) },
    );
    return { status: res.status, json: (await res.json()) as unknown };
  };

  const bookings = () =>
    asAppSuperuser(db, (tx) => tx.booking.count({ where: { tenantId: tenant.tenantId } }));

  it('refuses a cookie write from another site, and writes nothing', async () => {
    const { status, json } = await book({ kind: 'cookie', who: player, site: 'cross-site' });
    expect(status).toBe(403);
    expect(code(json)).toBe('CROSS_SITE_REQUEST');
    expect(await bookings()).toBe(0);
  });

  it('refuses a cookie write from a sibling subdomain (same-site, not same-origin)', async () => {
    const { status } = await book({ kind: 'cookie', who: player, site: 'same-site' });
    expect(status).toBe(403);
  });

  it('accepts the same cookie write from this origin', async () => {
    const { status } = await book({ kind: 'cookie', who: player, site: 'same-origin' });
    expect(status).toBe(201);
    expect(await bookings()).toBe(1);
  });

  it('accepts a Bearer write whatever Sec-Fetch-Site says', async () => {
    const { status } = await book({ kind: 'bearer', who: player, site: 'cross-site' });
    expect(status).toBe(201);
  });

  it('refuses a page rendered for another account: 409 VIEWER_CHANGED, nothing written', async () => {
    const { status, json } = await book({
      kind: 'cookie',
      who: player,
      site: 'same-origin',
      viewer: 'cuser_someone_else',
    });
    expect(status).toBe(409);
    expect(code(json)).toBe('VIEWER_CHANGED');
    expect(await bookings()).toBe(0);
  });

  it('accepts the page rendered for this account', async () => {
    const { status } = await book({
      kind: 'cookie',
      who: player,
      site: 'same-origin',
      viewer: player.userId,
    });
    expect(status).toBe(201);
  });
});

// ══ POST /t/{slug}/bookings/{id}/review ══════════════════════════════

describe('POST /api/v1/t/:slug/bookings/:id/review', () => {
  const completedBooking = () =>
    asAppSuperuser(db, (tx) =>
      tx.booking.create({
        data: {
          tenantId: tenant.tenantId,
          resourceId,
          startTs: new Date(Date.now() - 2 * HOUR),
          endTs: new Date(Date.now() - HOUR),
          bookedByUserId: player.userId,
          status: 'COMPLETED',
          totalCents: 2400,
          idempotencyKey: `xs-${randomUUID()}`,
        },
      }),
    );

  const review = async (auth: Auth) => {
    const booking = await completedBooking();
    const res = await reviewRoute(
      new NextRequest(`http://t/api/v1/t/${tenant.tenantSlug}/bookings/${booking.id}/review`, {
        method: 'POST',
        headers: headersFor(auth),
        body: JSON.stringify({ rating: 5 }),
      }),
      { params: Promise.resolve({ slug: tenant.tenantSlug, id: booking.id }) },
    );
    return { status: res.status, json: (await res.json()) as unknown };
  };

  const reviews = () => asAppSuperuser(db, (tx) => tx.review.count({ where: { venueId } }));

  it('refuses a cross-site cookie write, and writes nothing', async () => {
    const { status, json } = await review({ kind: 'cookie', who: player, site: 'cross-site' });
    expect(status).toBe(403);
    expect(code(json)).toBe('CROSS_SITE_REQUEST');
    expect(await reviews()).toBe(0);
  });

  it('accepts it from this origin', async () => {
    const { status } = await review({ kind: 'cookie', who: player, site: 'same-origin' });
    expect(status).toBe(201);
  });

  it('accepts a cross-site Bearer write', async () => {
    const { status } = await review({ kind: 'bearer', who: player, site: 'cross-site' });
    expect(status).toBe(201);
  });

  it('refuses a stale viewer with 409, and writes nothing', async () => {
    const { status, json } = await review({
      kind: 'cookie',
      who: player,
      site: 'same-origin',
      viewer: 'cuser_someone_else',
    });
    expect(status).toBe(409);
    expect(code(json)).toBe('VIEWER_CHANGED');
    expect(await reviews()).toBe(0);
  });
});

// ══ POST /platform/moderation/cases/{id}/resolve ═════════════════════

describe('POST /api/v1/platform/moderation/cases/:id/resolve', () => {
  let moderator: TestIdentity;

  beforeEach(async () => {
    const id = (p: string) => `${p}${randomUUID().replace(/-/g, '').slice(0, 21)}`;
    const admin = id('cadm');
    const granter = id('cgrn');
    await asAppSuperuser(db, async (tx) => {
      await tx.$executeRawUnsafe(
        `INSERT INTO app_user (id,email,"createdAt","updatedAt")
         VALUES ($1,$2,now(),now()), ($3,$4,now(),now())`,
        admin,
        `${admin}@test.invalid`,
        granter,
        `${granter}@test.invalid`,
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO platform_admin_grant
           (id,"userId","grantedByUserId",reason,capabilities,"expiresAt")
         VALUES ($1,$2,$3,'review moderation rota',$4::"PlatformCapability"[], now() + interval '7 days')`,
        id('cg'),
        admin,
        granter,
        `{${PlatformCapability.REVIEW_MODERATE}}`,
      );
    });
    moderator = await signInAs(db, { userId: admin, memberships: [] });
    // Every moderation decision needs a second-factor step-up on this session
    // (#262). Done through the real routes, with a Bearer header, so what this
    // suite then varies is only the origin and the credential's carrier.
    await enrolAndStepUp(moderator.bearer);
  });

  /** A flagged review at the club, and its open case. */
  async function openCase() {
    const author = await seedPlayer(db, tenant.tenantId, 'author');
    const booking = await asAppSuperuser(db, (tx) =>
      tx.booking.create({
        data: {
          tenantId: tenant.tenantId,
          resourceId,
          startTs: new Date(Date.now() - 2 * HOUR),
          endTs: new Date(Date.now() - HOUR),
          bookedByUserId: author,
          status: 'COMPLETED',
          totalCents: 2400,
          idempotencyKey: `xs-${randomUUID()}`,
        },
      }),
    );
    setModerationScores({ harassment: 0.72 });
    const r = await createReview((fn) => asAppUser(db, tenant.tenantId, fn), {
      tenantId: tenant.tenantId,
      bookingId: booking.id,
      authorUserId: author,
      rating: 1,
      body: 'the owner is a thief',
    });
    const c = await asAppSuperuser(db, (tx) =>
      tx.moderationCase.findFirstOrThrow({ where: { subjectId: r.id, status: 'OPEN' } }),
    );
    return c.id;
  }

  const decide = async (auth: Auth) => {
    const caseId = await openCase();
    const res = await resolveRoute(
      new NextRequest(`http://t/api/v1/platform/moderation/cases/${caseId}/resolve`, {
        method: 'POST',
        headers: headersFor(auth),
        body: JSON.stringify({ decision: 'APPROVE', note: 'honest criticism, not abuse' }),
      }),
      { params: Promise.resolve({ id: caseId }) },
    );
    const status = await asAppSuperuser(db, (tx) =>
      tx.moderationCase.findUniqueOrThrow({ where: { id: caseId }, select: { status: true } }),
    );
    return { status: res.status, json: (await res.json()) as unknown, caseStatus: status.status };
  };

  const decisionRows = () =>
    asAppSuperuser(db, (tx) =>
      tx.platformAuditEntry.count({ where: { action: 'PLATFORM_REVIEW_APPROVED' } }),
    );

  it('refuses a cross-site cookie decision: the case stays open and no audit row is written', async () => {
    const { status, json, caseStatus } = await decide({
      kind: 'cookie',
      who: moderator,
      site: 'cross-site',
    });
    expect(status).toBe(403);
    expect(code(json)).toBe('CROSS_SITE_REQUEST');
    expect(caseStatus).toBe('OPEN');
    expect(await decisionRows()).toBe(0);
  });

  it('accepts it from this origin', async () => {
    const { status, caseStatus } = await decide({
      kind: 'cookie',
      who: moderator,
      site: 'same-origin',
      viewer: moderator.userId,
    });
    expect(status).toBe(200);
    expect(caseStatus).not.toBe('OPEN');
  });

  it('accepts a cross-site Bearer decision', async () => {
    const { status } = await decide({ kind: 'bearer', who: moderator, site: 'cross-site' });
    expect(status).toBe(200);
  });

  it('refuses a stale viewer with 409: the case stays open', async () => {
    const { status, json, caseStatus } = await decide({
      kind: 'cookie',
      who: moderator,
      site: 'same-origin',
      viewer: player.userId,
    });
    expect(status).toBe(409);
    expect(code(json)).toBe('VIEWER_CHANGED');
    expect(caseStatus).toBe('OPEN');
    expect(await decisionRows()).toBe(0);
  });
});
