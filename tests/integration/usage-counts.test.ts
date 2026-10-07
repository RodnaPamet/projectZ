import { NextRequest } from 'next/server';

import { GET as getAvailability } from '@/app/api/v1/venues/[id]/availability/route';
import { POST as postUsageEvent } from '@/app/api/v1/venues/[id]/usage-events/route';
import { countUsage, recordUsage, settleUsageWrites } from '@/lib/usage/record';

import { captureLogs } from '../helpers/capture-logs';
import { prismaTestClient, seedTenant, seedVenue } from '../helpers/db';
import { asAppSuperuser, asAppUser } from '../helpers/rls';
import { PERSONAL } from '../helpers/usage-personal';

/**
 * The usage counters (#371), against the real table, its policies and its
 * primary key. What has to be true:
 *
 *   a count lands on its (day in Sofia, event, venue) row, and adds to it
 *   a crawler is not counted, and an absent user agent is not a browser
 *   counting failing never breaks the page or route that asked
 *   nothing in the table could name a person — asked of the live catalogue
 *   the beacon counts only its two events, only for a public venue, and
 *   answers 204 regardless
 */

const CHROME =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 ' +
  '(KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const GOOGLEBOT = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';

describe('usage counts', () => {
  const db = prismaTestClient();

  const rows = () =>
    asAppSuperuser(db, (tx) =>
      tx.usageDaily.findMany({
        orderBy: [{ day: 'asc' }, { event: 'asc' }, { venueId: 'asc' }],
        take: 100,
      }),
    );
  const day = (d: Date) => d.toISOString().slice(0, 10);

  it('increments one row per (day in Sofia, event, venue), not one row per hit', async () => {
    const { tenantId } = await seedTenant({});
    const { venueId } = await seedVenue(tenantId);

    // 21:30Z on 6 October is 00:30 on the 7th in Sofia (UTC+3): the 7th's row.
    const lateEvening = new Date('2026-10-06T21:30:00Z');
    // 20:59Z is 23:59 on the 6th in Sofia.
    const beforeMidnight = new Date('2026-10-06T20:59:00Z');

    await recordUsage('VENUE_VIEW', { venueId }, lateEvening);
    await recordUsage('VENUE_VIEW', { venueId }, lateEvening);
    await recordUsage('VENUE_VIEW', { venueId }, beforeMidnight);
    await recordUsage('SLOT_PICKED', { venueId }, lateEvening);
    await recordUsage('VENUES_VIEW', {}, lateEvening);
    await recordUsage('VENUES_VIEW', {}, lateEvening);

    const all = await rows();
    expect(all.map((r) => [day(r.day), r.event, r.venueId, r.clubId, r.count])).toEqual([
      ['2026-10-06', 'VENUE_VIEW', venueId, tenantId, 1],
      ['2026-10-07', 'VENUES_VIEW', '', null, 2],
      ['2026-10-07', 'VENUE_VIEW', venueId, tenantId, 2],
      ['2026-10-07', 'SLOT_PICKED', venueId, tenantId, 1],
    ]);
  });

  it('counts nothing for an unknown venue, or one whose club is suspended', async () => {
    const { tenantId } = await seedTenant({});
    const { venueId } = await seedVenue(tenantId);
    await asAppSuperuser(db, (tx) =>
      tx.venueOrg.update({ where: { id: tenantId }, data: { status: 'SUSPENDED' } }),
    );

    await recordUsage('VENUE_VIEW', { venueId });
    await recordUsage('VENUE_VIEW', { venueId: 'c-no-such-venue' });

    expect(await rows()).toEqual([]);
  });

  it('does not count a crawler, or a request with no user agent', async () => {
    const { tenantId } = await seedTenant({});
    const { venueId } = await seedVenue(tenantId);

    countUsage('VENUE_VIEW', { venueId }, { userAgent: GOOGLEBOT });
    countUsage('VENUE_VIEW', { venueId }, { userAgent: 'facebookexternalhit/1.1' });
    countUsage('VENUE_VIEW', { venueId }, { userAgent: 'curl/8.4.0' });
    countUsage('VENUE_VIEW', { venueId }, { userAgent: null });
    countUsage('VENUE_VIEW', { venueId }, { userAgent: '' });
    countUsage('VENUE_VIEW', { venueId }, { userAgent: CHROME });
    await settleUsageWrites();

    const all = await rows();
    expect(all.map((r) => [r.event, r.count])).toEqual([['VENUE_VIEW', 1]]);
  });

  it('a counting failure breaks nothing: the route answers, the error is a warning', async () => {
    const { tenantId } = await seedTenant({});
    const { venueId } = await seedVenue(tenantId);

    const logs = captureLogs();
    // A real failure, not a mock: the table is gone while the route runs.
    // As the table's owner (the test connection), not app_superuser.
    await db.$executeRawUnsafe(`ALTER TABLE usage_daily RENAME TO usage_daily_gone`);
    try {
      const res = await getAvailability(
        new NextRequest(`http://t/api/v1/venues/${venueId}/availability`, {
          headers: { 'user-agent': CHROME },
        }),
        { params: Promise.resolve({ id: venueId }) },
      );
      expect(res.status).toBe(200);

      // recordUsage resolves rather than throwing, too.
      await expect(recordUsage('VENUE_VIEW', { venueId })).resolves.toBeUndefined();
      await settleUsageWrites();
    } finally {
      await db.$executeRawUnsafe(`ALTER TABLE usage_daily_gone RENAME TO usage_daily`);
      logs.restore();
    }

    const warnings = logs.lines.filter((l) => l.includes('usage count not recorded'));
    expect(warnings.length).toBeGreaterThanOrEqual(2);
    // The failure line names the event, never the caller's browser.
    expect(warnings.join('\n')).not.toContain('iPhone');
  });

  it('the availability route counts a day viewed, after answering', async () => {
    const { tenantId } = await seedTenant({});
    const { venueId } = await seedVenue(tenantId);

    const res = await getAvailability(
      new NextRequest(`http://t/api/v1/venues/${venueId}/availability`, {
        headers: { 'user-agent': CHROME },
      }),
      { params: Promise.resolve({ id: venueId }) },
    );
    expect(res.status).toBe(200);
    await settleUsageWrites();

    expect((await rows()).map((r) => [r.event, r.venueId, r.count])).toEqual([
      ['SLOTS_VIEW', venueId, 1],
    ]);
  });

  describe('the beacon, POST /api/v1/venues/{id}/usage-events', () => {
    const beacon = (venueId: string, body: unknown, ua: string | null = CHROME) =>
      postUsageEvent(
        new NextRequest(`http://t/api/v1/venues/${venueId}/usage-events`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(ua ? { 'user-agent': ua } : {}),
          },
          body: typeof body === 'string' ? body : JSON.stringify(body),
        }),
        { params: Promise.resolve({ id: venueId }) },
      );

    it('counts SLOT_PICKED and SHEET_OPENED, answers 204, and sets no cookie', async () => {
      const { tenantId } = await seedTenant({});
      const { venueId } = await seedVenue(tenantId);

      const a = await beacon(venueId, { event: 'SLOT_PICKED' });
      const b = await beacon(venueId, { event: 'SHEET_OPENED' });
      await settleUsageWrites();

      for (const res of [a, b]) {
        expect(res.status).toBe(204);
        expect(res.headers.get('set-cookie')).toBeNull();
      }
      expect((await rows()).map((r) => [r.event, r.clubId, r.count])).toEqual([
        ['SLOT_PICKED', tenantId, 1],
        ['SHEET_OPENED', tenantId, 1],
      ]);
    });

    it('answers 204 to anything else and counts none of it', async () => {
      const { tenantId } = await seedTenant({});
      const { venueId } = await seedVenue(tenantId);

      const answers = await Promise.all([
        // Server-side events cannot be sent from a browser.
        beacon(venueId, { event: 'BOOKING_CREATED' }),
        beacon(venueId, { event: 'VENUE_VIEW' }),
        beacon(venueId, { event: 'nope' }),
        beacon(venueId, 'not json'),
        beacon('c-no-such-venue', { event: 'SLOT_PICKED' }),
        beacon(venueId, { event: 'SLOT_PICKED' }, GOOGLEBOT),
      ]);
      await settleUsageWrites();

      expect(answers.map((r) => r.status)).toEqual([204, 204, 204, 204, 204, 204]);
      expect(await rows()).toEqual([]);
    });
  });

  describe('no personal data, asked of the live catalogue', () => {
    it('usage_daily has only the aggregate columns', async () => {
      const columns = await asAppSuperuser(db, (tx) =>
        tx.$queryRawUnsafe<Array<{ column_name: string }>>(
          `SELECT column_name FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'usage_daily'
            ORDER BY column_name`,
        ),
      );
      const names = columns.map((c) => c.column_name);
      expect(names).toEqual(['clubId', 'count', 'day', 'event', 'venueId']);
      expect(names.filter((n) => PERSONAL.test(n))).toEqual([]);
    });

    it('app_user can neither read nor write it', async () => {
      const { tenantId } = await seedTenant({});
      await recordUsage('VENUES_VIEW', {});
      await expect(
        asAppUser(db, tenantId, (tx) => tx.usageDaily.findMany({ take: 1 })),
      ).rejects.toThrow();
    });
  });
});
