import { randomUUID } from 'node:crypto';

import { type BookingChannel, type BookingStatus, PlatformCapability } from '@prisma/client';
import { encode } from 'next-auth/jwt';
import { NextRequest } from 'next/server';

import { UsageCardSlot } from '@/app/(app)/t/[slug]/admin/reports/UsageCardSlot';
import { GET as usageRoute } from '@/app/api/v1/platform/usage/route';
import {
  ACTIVE_WINDOW_DAYS,
  type ClubOnlineShare,
  countBookingsByChannel,
  isClubActive,
  loadClubOnlineShare,
  loadPlatformUsage,
} from '@/app-layer/usecases/usage-report';
import { createUserSession, newSessionSecret } from '@/lib/auth/sessions';
import { runInTenantContext } from '@/lib/db/rls-middleware';
import { recordUsage } from '@/lib/usage/record';

import { prismaTestClient, seedTenant, seedVenue } from '../helpers/db';
import { captureLogs } from '../helpers/capture-logs';
import { asAppSuperuser } from '../helpers/rls';

/**
 * The pilot's numbers (#371): the online share, the active-club rule, the
 * funnel, and who may read them.
 *
 * The share and activity are counted from `booking` itself, so the fixtures
 * here are bookings in every status and both channels; the funnel is counted
 * from `usage_daily`, written through `recordUsage` as production writes it.
 */

const DAY_MS = 86_400_000;
// A fixed "now": 15 October 2026, 12:00 in Sofia (UTC+3).
const NOW = new Date('2026-10-15T09:00:00Z');

describe('usage report', () => {
  const db = prismaTestClient();

  let seq = 0;
  async function book(
    tenantId: string,
    resourceId: string,
    opts: { startTs: string; status: BookingStatus; channel: BookingChannel; createdAt?: Date },
  ) {
    // An hour each, an hour apart per call, so the no-overlap constraint never
    // sees two holds on the same court at once.
    const start = new Date(new Date(opts.startTs).getTime() + seq++ * 3_600_000);
    await asAppSuperuser(db, (tx) =>
      tx.booking.create({
        data: {
          tenantId,
          resourceId,
          startTs: start,
          endTs: new Date(start.getTime() + 3_600_000),
          status: opts.status,
          channel: opts.channel,
          totalCents: 2400,
          idempotencyKey: `k-${randomUUID()}`,
          ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
        },
      }),
    );
  }

  describe('the online share (one definition: countBookingsByChannel)', () => {
    it('online ÷ (online + desk), CONFIRMED and COMPLETED only, by the Sofia month it starts in', async () => {
      const club = await seedTenant({});
      const { resourceId } = await seedVenue(club.tenantId);
      const oct = '2026-10-10T08:00:00Z';

      await book(club.tenantId, resourceId, {
        startTs: oct,
        status: 'CONFIRMED',
        channel: 'ONLINE',
      });
      await book(club.tenantId, resourceId, {
        startTs: oct,
        status: 'COMPLETED',
        channel: 'ONLINE',
      });
      await book(club.tenantId, resourceId, { startTs: oct, status: 'CONFIRMED', channel: 'DESK' });
      // None of these count, on either side.
      await book(club.tenantId, resourceId, {
        startTs: oct,
        status: 'CANCELLED',
        channel: 'ONLINE',
      });
      await book(club.tenantId, resourceId, { startTs: oct, status: 'CANCELLED', channel: 'DESK' });
      await book(club.tenantId, resourceId, { startTs: oct, status: 'NO_SHOW', channel: 'ONLINE' });
      await book(club.tenantId, resourceId, { startTs: oct, status: 'PENDING', channel: 'ONLINE' });
      // 30 September 22:30Z is 1 October 01:30 in Sofia: October's.
      seq = 0;
      await book(club.tenantId, resourceId, {
        startTs: '2026-09-30T22:30:00Z',
        status: 'CONFIRMED',
        channel: 'ONLINE',
      });
      // 30 September 20:00Z is 23:00 on the 30th in Sofia: September's.
      await book(club.tenantId, resourceId, {
        startTs: '2026-09-30T19:00:00Z',
        status: 'CONFIRMED',
        channel: 'DESK',
      });

      const rows = await asAppSuperuser(db, (tx) =>
        countBookingsByChannel(tx, {
          from: new Date('2026-08-31T21:00:00Z'),
          to: new Date('2026-10-31T22:00:00Z'),
          bucket: 'month',
        }),
      );
      const byMonth = Object.fromEntries(rows.map((r) => [r.bucket, [r.online, r.desk]]));
      expect(byMonth).toEqual({ '2026-10-01': [3, 1], '2026-09-01': [0, 1] });

      const report = await asAppSuperuser(db, (tx) =>
        loadPlatformUsage(tx, { now: NOW, days: 30 }),
      );
      const row = report.clubs.find((c) => c.id === club.tenantId)!;
      expect(row.thisMonth).toEqual({ online: 3, desk: 1, share: 0.75 });
      expect(row.lastMonth).toEqual({ online: 0, desk: 1, share: 0 });
      expect(row.trend).toBe('up');
      expect(report.month).toBe('2026-10');
      expect(report.previousMonth).toBe('2026-09');
    });

    it('a period with no bookings has no share and no trend, not 0%', async () => {
      const club = await seedTenant({});
      const report = await asAppSuperuser(db, (tx) => loadPlatformUsage(tx, { now: NOW, days: 7 }));
      const row = report.clubs.find((c) => c.id === club.tenantId)!;
      expect(row.thisMonth.share).toBeNull();
      expect(row.trend).toBeNull();
      expect(row.weeks).toHaveLength(8);
      expect(row.weeks.at(-1)!.week).toBe('2026-10-12'); // the Monday of NOW's week
    });

    it('a club’s own card sees only its own bookings, under its tenant binding', async () => {
      const mine = await seedTenant({});
      const theirs = await seedTenant({});
      const a = await seedVenue(mine.tenantId);
      const b = await seedVenue(theirs.tenantId);
      await book(mine.tenantId, a.resourceId, {
        startTs: '2026-10-05T08:00:00Z',
        status: 'CONFIRMED',
        channel: 'ONLINE',
      });
      await book(mine.tenantId, a.resourceId, {
        startTs: '2026-08-05T08:00:00Z',
        status: 'COMPLETED',
        channel: 'DESK',
      });
      await book(theirs.tenantId, b.resourceId, {
        startTs: '2026-10-05T08:00:00Z',
        status: 'CONFIRMED',
        channel: 'DESK',
      });

      const card = await runInTenantContext(mine.tenantId, (tx) =>
        loadClubOnlineShare(tx, mine.tenantId, { now: NOW }),
      );
      expect(card.months.map((m) => [m.month, m.online, m.desk, m.share])).toEqual([
        ['2026-05', 0, 0, null],
        ['2026-06', 0, 0, null],
        ['2026-07', 0, 0, null],
        ['2026-08', 0, 1, 0],
        ['2026-09', 0, 0, null],
        ['2026-10', 1, 0, 1],
      ]);

      // The month the reports page shows: the card ends there, across a year end.
      const august = await runInTenantContext(mine.tenantId, (tx) =>
        loadClubOnlineShare(tx, mine.tenantId, { month: '2026-08', now: NOW }),
      );
      expect(august.months.map((m) => m.month)).toEqual([
        '2026-03',
        '2026-04',
        '2026-05',
        '2026-06',
        '2026-07',
        '2026-08',
      ]);
      expect(august.months.at(-1)).toMatchObject({ online: 0, desk: 1, share: 0 });
      const february = await runInTenantContext(mine.tenantId, (tx) =>
        loadClubOnlineShare(tx, mine.tenantId, { month: '2027-02' }),
      );
      expect(february.months[0]!.month).toBe('2026-09');
      // A malformed month is this month, never a query on nonsense.
      const fallback = await runInTenantContext(mine.tenantId, (tx) =>
        loadClubOnlineShare(tx, mine.tenantId, { month: '2026-13', now: NOW }),
      );
      expect(fallback.months.at(-1)!.month).toBe('2026-10');
    });
  });

  describe('the slot on "Отчети и такса" (#372)', () => {
    it('renders the card for the month the page shows', async () => {
      const club = await seedTenant({});
      const { resourceId } = await seedVenue(club.tenantId);
      await book(club.tenantId, resourceId, {
        startTs: '2026-09-15T08:00:00Z',
        status: 'COMPLETED',
        channel: 'ONLINE',
      });

      const el = await UsageCardSlot({
        tenantId: club.tenantId,
        slug: club.tenantSlug,
        month: '2026-09',
      });
      const data = (el as { props: { data: ClubOnlineShare } } | null)?.props.data;
      expect(data?.months.at(-1)).toEqual({ month: '2026-09', online: 1, desk: 0, share: 1 });
      expect(data?.months).toHaveLength(6);
    });

    it('a failed read leaves the statement standing: no card, and a warning', async () => {
      const logs = captureLogs();
      try {
        // A tenant id the binding refuses: a real failure inside the read.
        const el = await UsageCardSlot({ tenantId: 'not-a-club', slug: 'x', month: '2026-09' });
        expect(el).toBeNull();
      } finally {
        logs.restore();
      }
      expect(logs.lines.some((l) => l.includes('online share card not rendered'))).toBe(true);
    });
  });

  describe('the active-club rule (isClubActive)', () => {
    it('a booking made in the last 14 days, in either channel, keeps a club active', async () => {
      const recent = await seedTenant({ name: 'Recent' });
      const stale = await seedTenant({ name: 'Stale' });
      const cancelledOnly = await seedTenant({ name: 'Cancelled only' });
      const r = await seedVenue(recent.tenantId);
      const s = await seedVenue(stale.tenantId);
      const c = await seedVenue(cancelledOnly.tenantId);
      const now = new Date();

      await book(recent.tenantId, r.resourceId, {
        startTs: '2026-12-01T08:00:00Z',
        status: 'CONFIRMED',
        channel: 'DESK',
        createdAt: new Date(now.getTime() - 13 * DAY_MS),
      });
      await book(stale.tenantId, s.resourceId, {
        startTs: '2026-12-01T08:00:00Z',
        status: 'CONFIRMED',
        channel: 'ONLINE',
        createdAt: new Date(now.getTime() - 15 * DAY_MS),
      });
      await book(cancelledOnly.tenantId, c.resourceId, {
        startTs: '2026-12-01T08:00:00Z',
        status: 'CANCELLED',
        channel: 'ONLINE',
        createdAt: new Date(now.getTime() - DAY_MS),
      });

      const report = await asAppSuperuser(db, (tx) => loadPlatformUsage(tx, { now, days: 30 }));
      const active = Object.fromEntries(report.clubs.map((x) => [x.name, x.active]));
      expect(active).toEqual({ Recent: true, Stale: false, 'Cancelled only': false });
    });

    it('the boundary is inclusive at 14 days', () => {
      const now = new Date('2026-10-15T09:00:00Z');
      expect(ACTIVE_WINDOW_DAYS).toBe(14);
      expect(isClubActive(new Date(now.getTime() - 14 * DAY_MS), now)).toBe(true);
      expect(isClubActive(new Date(now.getTime() - 14 * DAY_MS - 1), now)).toBe(false);
      expect(isClubActive(null, now)).toBe(false);
    });
  });

  describe('the funnel', () => {
    it('sums the counters over the range, for the site and per venue', async () => {
      const club = await seedTenant({});
      const { venueId } = await seedVenue(club.tenantId, { name: 'Padel Centre' });
      const today = NOW;
      const longAgo = new Date(NOW.getTime() - 40 * DAY_MS);

      for (const [event, n] of [
        ['VENUE_VIEW', 4],
        ['SLOT_PICKED', 2],
        ['SHEET_OPENED', 2],
        ['BOOKING_CREATED', 1],
      ] as const) {
        for (let i = 0; i < n; i++) await recordUsage(event, { venueId }, today);
      }
      for (let i = 0; i < 10; i++) await recordUsage('VENUES_VIEW', {}, today);
      // Outside a 30-day range.
      await recordUsage('VENUE_VIEW', { venueId }, longAgo);

      const report = await asAppSuperuser(db, (tx) =>
        loadPlatformUsage(tx, { now: NOW, days: 30 }),
      );
      expect(report.funnel).toMatchObject({ days: 30, from: '2026-09-16', to: '2026-10-15' });
      expect(report.funnel.site).toEqual({
        VENUES_VIEW: 10,
        VENUE_VIEW: 4,
        SLOTS_VIEW: 0,
        SLOT_PICKED: 2,
        SHEET_OPENED: 2,
        BOOKING_CREATED: 1,
      });
      expect(report.funnel.venues).toEqual([
        expect.objectContaining({
          venueId,
          venueName: 'Padel Centre',
          clubId: club.tenantId,
          counts: expect.objectContaining({ VENUE_VIEW: 4, BOOKING_CREATED: 1 }),
        }),
      ]);
    });
  });

  // ── Who may read it ──────────────────────────────────────────────────
  describe('GET /api/v1/platform/usage', () => {
    let admin: string;
    let granter: string;

    beforeEach(async () => {
      admin = `cadm${randomUUID().replace(/-/g, '').slice(0, 21)}`;
      granter = `cgrn${randomUUID().replace(/-/g, '').slice(0, 21)}`;
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
    });

    async function grant(caps: PlatformCapability[]) {
      await asAppSuperuser(db, (tx) =>
        tx.$executeRawUnsafe(
          `INSERT INTO platform_admin_grant
             (id,"userId","grantedByUserId",reason,capabilities,"grantedAt","expiresAt")
           VALUES ($1,$2,$3,'pilot metrics rota',$4::"PlatformCapability"[],
                   now() - interval '1 day', now() + interval '29 days')`,
          `cg${randomUUID().replace(/-/g, '').slice(0, 20)}`,
          admin,
          granter,
          `{${caps.join(',')}}`,
        ),
      );
    }

    async function bearer() {
      const { userSessionId, sessionVersion } = await createUserSession({
        userId: admin,
        sessionSecret: newSessionSecret(),
        expiresAt: new Date(Date.now() + 3600_000),
      });
      return encode({
        secret: process.env.NEXTAUTH_SECRET!,
        maxAge: 900,
        token: { sub: admin, userSessionId, sessionVersion },
      });
    }

    const get = async (query: string, token?: string) =>
      usageRoute(
        new NextRequest(`http://t/api/v1/platform/usage${query}`, {
          headers: token ? { authorization: `Bearer ${token}` } : {},
        }),
        undefined as never,
      );

    const REASON = '?reason=weekly%20pilot%20review';

    it('401 without a token', async () => {
      expect((await get(REASON)).status).toBe(401);
    });

    it('403 without a platform grant', async () => {
      const res = await get(REASON, await bearer());
      expect(res.status).toBe(403);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
        'PLATFORM_AUTHORITY_REQUIRED',
      );
    });

    it('403 with a grant that does not carry TENANT_READ', async () => {
      await grant([PlatformCapability.AUDIT_READ]);
      const res = await get(REASON, await bearer());
      expect(res.status).toBe(403);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
        'PLATFORM_CAPABILITY_REQUIRED',
      );
    });

    it('400 without a reason, or with a range it does not offer', async () => {
      await grant([PlatformCapability.TENANT_READ]);
      const token = await bearer();
      expect((await get('', token)).status).toBe(400);
      expect((await get(`${REASON}&days=14`, token)).status).toBe(400);
    });

    it('200 with TENANT_READ and no step-up, audited with the reason', async () => {
      const club = await seedTenant({ name: 'Metrics Club' });
      await grant([PlatformCapability.TENANT_READ]);

      const res = await get(`${REASON}&days=7`, await bearer());
      expect(res.status).toBe(200);
      const { data } = (await res.json()) as {
        data: { clubs: Array<{ id: string; startedAt: string }>; funnel: { days: number } };
      };
      expect(data.clubs.map((c) => c.id)).toEqual([club.tenantId]);
      // RFC 3339 without fractional seconds, as every v1 timestamp.
      expect(data.clubs[0]!.startedAt).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
      expect(data.funnel.days).toBe(7);

      const audit = await asAppSuperuser(db, (tx) =>
        tx.platformAuditEntry.findMany({
          select: { action: true, capability: true, reason: true, subjectTenantId: true },
          take: 5,
        }),
      );
      expect(audit).toEqual([
        {
          action: 'PLATFORM_USAGE_READ',
          capability: 'TENANT_READ',
          reason: 'weekly pilot review',
          subjectTenantId: null,
        },
      ]);
    });
  });
});
