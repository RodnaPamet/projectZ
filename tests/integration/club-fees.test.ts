import { randomUUID } from 'node:crypto';

import { type BookingChannel, type BookingStatus, PlatformCapability } from '@prisma/client';
import { encode } from 'next-auth/jwt';
import { NextRequest } from 'next/server';

import { GET as overviewRoute } from '@/app/api/v1/platform/fees/route';
import { GET as platformCsvRoute } from '@/app/api/v1/platform/fees/[clubId]/statement/csv/route';
import { GET as platformStatementRoute } from '@/app/api/v1/platform/fees/[clubId]/statement/route';
import { PUT as termsRoute } from '@/app/api/v1/platform/fees/[clubId]/terms/route';
import { GET as csvRoute } from '@/app/api/v1/t/[slug]/admin/statements/csv/route';
import { GET as statementRoute } from '@/app/api/v1/t/[slug]/admin/statements/route';
import { completeEndedBookings, markNoShow } from '@/app-layer/usecases/booking-outcome';
import {
  loadClubStatement,
  recordFeeCharges,
  recordMissingFeeCharges,
  reverseFeeCharge,
} from '@/app-layer/usecases/club-fees';
import { createUserSession, newSessionSecret } from '@/lib/auth/sessions';

import { signInAs, type TestIdentity } from '../helpers/auth';
import { enrolAndStepUp } from '../helpers/mfa';
import { prismaTestClient, seedAccount, seedTenant, type SeededTenant } from '../helpers/db';
import { asAppSuperuser, asAppUser } from '../helpers/rls';

/**
 * THE CLUB FEE (#372), against a real database: the ledger the completion
 * sweep writes, the free period, corrections, idempotency, the statements and
 * their CSV, who may read them, and the platform's terms behind a step-up.
 *
 * The owner's rules: a percentage of the court price, per club; only ONLINE
 * bookings that end COMPLETED; a free period per club (default two months),
 * listed at 0; a monthly statement per club in Sofia's calendar.
 */

const db = prismaTestClient();
const HOUR = 3_600_000;
const REASON = 'invoicing the pilot clubs for 2026-10';

type Json = {
  data?: Record<string, unknown>;
  error?: { code: string; details?: Record<string, unknown> };
};

interface Club {
  tenant: SeededTenant;
  owner: TestIdentity;
  venueId: string;
  courtIds: string[];
}

/** A club with a venue and two courts, its fee terms set directly. */
async function seedClub(
  terms: { feePercent?: string; feeStartsOn?: string } = {},
  courtNames: [string, string] = ['Корт 1', 'Корт 2'],
): Promise<Club> {
  const tenant = await seedTenant({}, db);
  const { venueId, courtIds } = await asAppSuperuser(db, async (tx) => {
    await tx.venueOrg.update({
      where: { id: tenant.tenantId },
      data: {
        feePercent: terms.feePercent ?? '10',
        feeStartsOn: new Date(`${terms.feeStartsOn ?? '2026-01-01'}T00:00:00Z`),
      },
    });
    const venue = await tx.venue.create({
      data: {
        tenantId: tenant.tenantId,
        slug: `fee-${tenant.tenantId.slice(-8)}`,
        name: 'Обект Изток',
        addressLine: '1 Court St',
        city: 'Sofia',
        lat: 42.6977,
        lng: 23.3219,
        email: 'desk@club.test',
      },
    });
    const courtIds: string[] = [];
    for (const name of courtNames) {
      const c = await tx.resource.create({
        data: {
          tenantId: tenant.tenantId,
          venueId: venue.id,
          name,
          sport: 'PADEL',
          surface: 'HARD',
          basePriceCents: 2400,
        },
      });
      courtIds.push(c.id);
    }
    return { venueId: venue.id, courtIds };
  });
  const owner = await signInAs(db, {
    userId: tenant.userId,
    memberships: [{ tenantId: tenant.tenantId, tenantSlug: tenant.tenantSlug, role: 'OWNER' }],
  });
  return { tenant, owner, venueId, courtIds };
}

/** A booking at `club`, one hour from `start`, on its own court index so nothing overlaps. */
let courtTurn = 0;
async function seedBooking(
  club: Club,
  opts: {
    start: string;
    status?: BookingStatus;
    channel?: BookingChannel;
    totalCents?: number;
    court?: number;
  },
) {
  const start = new Date(opts.start);
  // Alternate courts and spread by minutes, so two bookings at one start never clash.
  const resourceId = club.courtIds[opts.court ?? courtTurn++ % 2]!;
  return asAppSuperuser(db, (tx) =>
    tx.booking.create({
      data: {
        tenantId: club.tenant.tenantId,
        resourceId,
        startTs: start,
        endTs: new Date(start.getTime() + HOUR),
        status: opts.status ?? 'CONFIRMED',
        channel: opts.channel ?? 'ONLINE',
        totalCents: opts.totalCents ?? 2400,
        idempotencyKey: `fee-${randomUUID()}`,
      },
    }),
  );
}

const sweep = (now: Date) => asAppSuperuser(db, (tx) => completeEndedBookings(tx, { now }));

const linesOf = (bookingId: string) =>
  asAppSuperuser(db, (tx) =>
    tx.clubFeeLine.findMany({ where: { bookingId }, orderBy: { kind: 'asc' }, take: 10 }),
  );

const read = async (res: Response) => ({ status: res.status, body: (await res.json()) as Json });

function clubGet(
  route: typeof statementRoute,
  slug: string,
  who: TestIdentity | null,
  month?: string,
  path = 'statements',
) {
  const qs = month ? `?month=${month}` : '';
  return route(
    new NextRequest(`http://t/api/v1/t/${slug}/admin/${path}${qs}`, {
      headers: who ? { authorization: `Bearer ${who.bearer}` } : {},
    }),
    { params: Promise.resolve({ slug }) },
  );
}

/** A CLUB account holding `role` at `club`. */
async function memberOf(club: Club, role: 'MANAGER' | 'STAFF') {
  const userId = await seedAccount('CLUB', db);
  await asAppSuperuser(db, (tx) =>
    tx.tenantMembership.create({
      data: { tenantId: club.tenant.tenantId, userId, role, status: 'ACTIVE' },
    }),
  );
  return signInAs(db, {
    userId,
    memberships: [{ tenantId: club.tenant.tenantId, tenantSlug: club.tenant.tenantSlug, role }],
  });
}

// ══ The ledger ════════════════════════════════════════════════════════════

describe('the fee line written on completion', () => {
  const NOW = new Date('2026-10-20T12:00:00Z');

  it('charges an ONLINE booking that completes, and nothing else', async () => {
    const club = await seedClub({ feePercent: '10' });
    const online = await seedBooking(club, { start: '2026-10-19T17:00:00Z' });
    const desk = await seedBooking(club, { start: '2026-10-19T17:00:00Z', channel: 'DESK' });
    const cancelled = await seedBooking(club, {
      start: '2026-10-18T17:00:00Z',
      status: 'CANCELLED',
    });
    const noShow = await seedBooking(club, { start: '2026-10-18T17:00:00Z', status: 'NO_SHOW' });

    const result = await sweep(NOW);
    expect(result.completed).toBe(2); // online + desk
    expect(result.feeLines).toBe(1);

    const [line] = await linesOf(online.id);
    expect(line).toMatchObject({
      tenantId: club.tenant.tenantId,
      kind: 'CHARGE',
      venueId: club.venueId,
      venueName: 'Обект Изток',
      statementMonth: '2026-10',
      priceCents: 2400,
      feeBps: 1000,
      freePeriod: false,
      feeCents: 240,
      currency: 'EUR',
    });
    expect(line!.bookingStartTs.toISOString()).toBe('2026-10-19T17:00:00.000Z');

    for (const b of [desk, cancelled, noShow]) expect(await linesOf(b.id)).toEqual([]);
  });

  it('gives 0 in the free period, and still lists the booking', async () => {
    const club = await seedClub({ feePercent: '15', feeStartsOn: '2026-10-20' });
    // 23:30 on 19 October in Sofia: the day before charging starts.
    const free = await seedBooking(club, { start: '2026-10-19T20:30:00Z' });
    // 00:30 on 20 October in Sofia (21:30Z on the 19th): charged.
    const charged = await seedBooking(club, { start: '2026-10-19T21:30:00Z' });
    await sweep(new Date('2026-10-20T06:00:00Z'));

    expect((await linesOf(free.id))[0]).toMatchObject({
      freePeriod: true,
      feeBps: 1500,
      feeCents: 0,
    });
    expect((await linesOf(charged.id))[0]).toMatchObject({ freePeriod: false, feeCents: 360 });
  });

  it('defaults the free period to two months from the club’s creation when the column is null', async () => {
    const club = await seedClub({ feePercent: '10' });
    await asAppSuperuser(db, (tx) =>
      tx.venueOrg.update({
        where: { id: club.tenant.tenantId },
        data: { feeStartsOn: null, createdAt: new Date('2026-09-10T09:00:00Z') },
      }),
    );
    const inside = await seedBooking(club, { start: '2026-11-09T17:00:00Z' });
    const after = await seedBooking(club, { start: '2026-11-10T17:00:00Z' });
    await sweep(new Date('2026-11-11T00:00:00Z'));
    expect((await linesOf(inside.id))[0]!.feeCents).toBe(0);
    expect((await linesOf(after.id))[0]!.feeCents).toBe(240);
  });

  it('a change to the club’s % affects only lines written after it', async () => {
    const club = await seedClub({ feePercent: '10' });
    const before = await seedBooking(club, { start: '2026-10-19T10:00:00Z' });
    await sweep(new Date('2026-10-19T12:00:00Z'));

    await asAppSuperuser(db, (tx) =>
      tx.venueOrg.update({ where: { id: club.tenant.tenantId }, data: { feePercent: '20' } }),
    );
    const later = await seedBooking(club, { start: '2026-10-19T14:00:00Z' });
    await sweep(NOW);

    expect((await linesOf(before.id))[0]).toMatchObject({ feeBps: 1000, feeCents: 240 });
    expect((await linesOf(later.id))[0]).toMatchObject({ feeBps: 2000, feeCents: 480 });
  });

  it('is idempotent: a second sweep, a repeated write and the catch-up write nothing more', async () => {
    const club = await seedClub();
    const b = await seedBooking(club, { start: '2026-10-19T10:00:00Z' });
    await sweep(NOW);
    expect((await sweep(NOW)).feeLines).toBe(0);
    expect(await asAppSuperuser(db, (tx) => recordFeeCharges(tx, [b.id, b.id]))).toBe(0);
    const caught = await asAppSuperuser(db, (tx) =>
      recordMissingFeeCharges(tx, { now: NOW, lookbackDays: null }),
    );
    expect(caught).toEqual({ found: 0, written: 0, truncated: false });
    expect(await linesOf(b.id)).toHaveLength(1);
  });

  it('backfills COMPLETED online bookings that predate it: the sweep a week back, the script all of it', async () => {
    const club = await seedClub();
    // Completed with no line, as by the previous image or before P48.
    const recent = await seedBooking(club, { start: '2026-10-17T10:00:00Z', status: 'COMPLETED' });
    const old = await seedBooking(club, { start: '2026-08-03T10:00:00Z', status: 'COMPLETED' });
    const desk = await seedBooking(club, {
      start: '2026-10-17T12:00:00Z',
      status: 'COMPLETED',
      channel: 'DESK',
    });

    // The sweep's own catch-up runs even when nothing new has ended.
    const run = await sweep(NOW);
    expect(run.completed).toBe(0);
    expect(run.feeLines).toBe(1);
    expect(await linesOf(recent.id)).toHaveLength(1);
    expect(await linesOf(old.id)).toHaveLength(0);

    const all = await asAppSuperuser(db, (tx) =>
      recordMissingFeeCharges(tx, { now: NOW, lookbackDays: null }),
    );
    expect(all.written).toBe(1);
    expect((await linesOf(old.id))[0]).toMatchObject({ statementMonth: '2026-08', feeCents: 240 });
    expect(await linesOf(desk.id)).toHaveLength(0);
  });

  it('refuses to be edited or deleted: the ledger is append-only', async () => {
    const club = await seedClub();
    const b = await seedBooking(club, { start: '2026-10-19T10:00:00Z' });
    await sweep(NOW);
    await expect(
      asAppSuperuser(db, (tx) =>
        tx.$executeRawUnsafe(
          `UPDATE club_fee_line SET "feeCents" = 0 WHERE "bookingId" = $1`,
          b.id,
        ),
      ),
    ).rejects.toThrow(/APPEND-ONLY/);
    await expect(
      asAppSuperuser(db, (tx) =>
        tx.$executeRawUnsafe(`DELETE FROM club_fee_line WHERE "bookingId" = $1`, b.id),
      ),
    ).rejects.toThrow(/APPEND-ONLY/);
  });

  it('a club cannot read or write another club’s lines', async () => {
    const a = await seedClub();
    const b = await seedClub();
    await seedBooking(a, { start: '2026-10-19T10:00:00Z' });
    await sweep(NOW);
    const seen = await asAppUser(db, b.tenant.tenantId, (tx) =>
      tx.clubFeeLine.count({ where: { tenantId: a.tenant.tenantId } }),
    );
    expect(seen).toBe(0);
  });
});

// ══ Corrections ═══════════════════════════════════════════════════════════

describe('a no-show marked after completion', () => {
  it('writes a REVERSAL in the month the no-show was marked, and the months net out', async () => {
    const club = await seedClub({ feePercent: '12.5' });
    // Played 31 October 20:00 in Sofia; completed; marked a no-show on 2 November.
    const b = await seedBooking(club, { start: '2026-10-31T18:00:00Z', totalCents: 3333 });
    await sweep(new Date('2026-10-31T20:00:00Z'));
    await asAppUser(db, club.tenant.tenantId, (tx) =>
      markNoShow(tx, club.tenant.tenantId, {
        bookingId: b.id,
        actorUserId: club.tenant.userId,
        now: new Date('2026-11-02T09:00:00Z'),
      }),
    );

    const [charge, reversal] = await linesOf(b.id);
    expect(charge).toMatchObject({ kind: 'CHARGE', statementMonth: '2026-10', feeCents: 417 });
    expect(reversal).toMatchObject({
      kind: 'REVERSAL',
      statementMonth: '2026-11',
      priceCents: -3333,
      feeCents: -417,
      feeBps: 1250,
    });

    // October, already invoiced, reads exactly as it did.
    const oct = await asAppUser(db, club.tenant.tenantId, (tx) =>
      loadClubStatement(tx, club.tenant.tenantId, '2026-10'),
    );
    expect(oct!.totals).toEqual({
      bookingsPlayed: 1,
      revenueCents: 3333,
      feeCents: 417,
      lineCount: 1,
    });
    const nov = await asAppUser(db, club.tenant.tenantId, (tx) =>
      loadClubStatement(tx, club.tenant.tenantId, '2026-11'),
    );
    expect(nov!.totals).toEqual({
      bookingsPlayed: -1,
      revenueCents: -3333,
      feeCents: -417,
      lineCount: 1,
    });
  });

  it('reverses once, however often it is asked', async () => {
    const club = await seedClub();
    const b = await seedBooking(club, { start: '2026-10-19T10:00:00Z' });
    await sweep(new Date('2026-10-19T12:00:00Z'));
    const twice = await asAppUser(db, club.tenant.tenantId, async (tx) => [
      await reverseFeeCharge(tx, club.tenant.tenantId, b.id),
      await reverseFeeCharge(tx, club.tenant.tenantId, b.id),
    ]);
    expect(twice).toEqual([true, false]);
    expect(await linesOf(b.id)).toHaveLength(2);
  });

  it('a no-show before completion leaves no line at all', async () => {
    const club = await seedClub();
    const b = await seedBooking(club, { start: '2026-10-19T10:00:00Z' });
    await asAppUser(db, club.tenant.tenantId, (tx) =>
      markNoShow(tx, club.tenant.tenantId, {
        bookingId: b.id,
        actorUserId: club.tenant.userId,
        now: new Date('2026-10-19T10:30:00Z'),
      }),
    );
    await sweep(new Date('2026-10-19T12:00:00Z'));
    expect(await linesOf(b.id)).toEqual([]);
  });

  it('racing the sweep, a no-show always nets the fee to zero', async () => {
    const club = await seedClub();
    const now = new Date('2026-10-19T12:00:00Z');
    const bookings = await Promise.all(
      Array.from({ length: 4 }, (_, i) =>
        seedBooking(club, { start: `2026-10-19T0${i + 4}:00:00Z`, court: i % 2 }),
      ),
    );
    await Promise.all([
      sweep(now),
      ...bookings.map((b) =>
        asAppUser(db, club.tenant.tenantId, (tx) =>
          markNoShow(tx, club.tenant.tenantId, {
            bookingId: b.id,
            actorUserId: club.tenant.userId,
            now,
          }),
        ),
      ),
    ]);
    for (const b of bookings) {
      const status = await asAppSuperuser(db, (tx) =>
        tx.booking.findUniqueOrThrow({ where: { id: b.id } }).then((r) => r.status),
      );
      expect(status).toBe('NO_SHOW');
      const lines = await linesOf(b.id);
      expect(lines.reduce((s, l) => s + l.feeCents, 0)).toBe(0);
    }
  });
});

// ══ Statements ════════════════════════════════════════════════════════════

describe('GET /t/{slug}/admin/statements', () => {
  it('totals are the sums of the lines, at Sofia’s month boundaries, across the October change', async () => {
    const club = await seedClub({ feePercent: '10' });
    const inOct = [
      // 00:30 on 1 October in Sofia (+03:00).
      { start: '2026-09-30T21:30:00Z', totalCents: 2400 },
      // The night of the change: 03:30 EEST, then 03:30 EET.
      { start: '2026-10-25T00:30:00Z', totalCents: 1999 },
      { start: '2026-10-25T01:30:00Z', totalCents: 1999 },
      // 23:30 on 31 October in Sofia (+02:00).
      { start: '2026-10-31T21:30:00Z', totalCents: 3333 },
    ];
    for (const b of inOct) await seedBooking(club, b);
    // Outside October at the club, though inside it in UTC.
    await seedBooking(club, { start: '2026-10-31T22:30:00Z', totalCents: 5000 });
    await seedBooking(club, { start: '2026-09-30T20:30:00Z', totalCents: 5000 });
    await sweep(new Date('2026-11-02T00:00:00Z'));

    const { status, body } = await read(
      await clubGet(statementRoute, club.tenant.tenantSlug, club.owner, '2026-10'),
    );
    expect(status).toBe(200);
    const data = body.data as {
      month: string;
      periodStart: string;
      periodEnd: string;
      feePercent: string;
      freePeriod: string;
      totals: Record<string, number>;
      lines: Array<{ feeCents: number; priceCents: number; startsAt: string }>;
    };
    expect(data.month).toBe('2026-10');
    expect(data.periodStart).toBe('2026-09-30T21:00:00Z');
    expect(data.periodEnd).toBe('2026-10-31T22:00:00Z');
    expect(data.feePercent).toBe('10.00');
    expect(data.freePeriod).toBe('none');
    expect(data.lines.map((l) => l.startsAt)).toEqual([
      '2026-09-30T21:30:00Z',
      '2026-10-25T00:30:00Z',
      '2026-10-25T01:30:00Z',
      '2026-10-31T21:30:00Z',
    ]);
    // 240 + 200 + 200 + 333: 199.9 rounds to 200 per line, 333.3 to 333.
    expect(data.lines.map((l) => l.feeCents)).toEqual([240, 200, 200, 333]);
    expect(data.totals).toEqual({
      bookingsPlayed: 4,
      revenueCents: 2400 + 1999 + 1999 + 3333,
      feeCents: 973,
      lineCount: 4,
    });
    // Not a percentage of the sum: 10% of 9731 would be 973.1 → 973 here, but
    // the total is defined as the lines' sum, which is what the CSV adds up to.
    expect(data.totals.feeCents).toBe(data.lines.reduce((s, l) => s + l.feeCents, 0));

    const nov = await read(
      await clubGet(statementRoute, club.tenant.tenantSlug, club.owner, '2026-11'),
    );
    expect((nov.body.data as { totals: { bookingsPlayed: number } }).totals.bookingsPlayed).toBe(1);
  });

  it('an empty month is an empty statement, and a bad month is a 400', async () => {
    const club = await seedClub();
    const empty = await read(
      await clubGet(statementRoute, club.tenant.tenantSlug, club.owner, '2025-01'),
    );
    expect(empty.status).toBe(200);
    expect((empty.body.data as { lines: unknown[] }).lines).toEqual([]);
    const bad = await read(
      await clubGet(statementRoute, club.tenant.tenantSlug, club.owner, '2026-13'),
    );
    expect(bad.status).toBe(400);
  });

  it('OWNER and MANAGER read it; STAFF get 403; another club, a stranger and no club get 404', async () => {
    const club = await seedClub();
    const other = await seedClub();
    const manager = await memberOf(club, 'MANAGER');
    const staff = await memberOf(club, 'STAFF');
    const slug = club.tenant.tenantSlug;

    expect((await clubGet(statementRoute, slug, manager)).status).toBe(200);

    const refused = await read(await clubGet(statementRoute, slug, staff));
    expect(refused.status).toBe(403);
    expect(refused.body.error?.details?.requiredPermission).toBe('admin.billing_manage');
    expect((await clubGet(csvRoute, slug, staff, undefined, 'statements/csv')).status).toBe(403);

    // The other club's owner, at this club's slug: not a member here.
    const idor = await read(await clubGet(statementRoute, slug, other.owner));
    expect(idor.status).toBe(404);
    expect(JSON.stringify(idor.body)).not.toContain(club.tenant.tenantId);
    expect((await clubGet(csvRoute, slug, other.owner, undefined, 'statements/csv')).status).toBe(
      404,
    );
    expect((await clubGet(statementRoute, 'no-such-club', club.owner)).status).toBe(404);
    expect((await clubGet(statementRoute, slug, null)).status).toBe(401);
  });

  it('a statement only ever holds its own club’s lines', async () => {
    const a = await seedClub();
    const b = await seedClub();
    await seedBooking(a, { start: '2026-10-19T10:00:00Z' });
    await seedBooking(b, { start: '2026-10-19T10:00:00Z' });
    await sweep(new Date('2026-10-20T00:00:00Z'));
    const { body } = await read(
      await clubGet(statementRoute, a.tenant.tenantSlug, a.owner, '2026-10'),
    );
    expect((body.data as { lines: unknown[] }).lines).toHaveLength(1);
  });
});

describe('GET /t/{slug}/admin/statements/csv', () => {
  it('is UTF-8 with a BOM, semicolon-separated, Bulgarian, and defuses formulas', async () => {
    const club = await seedClub({ feePercent: '12.5' }, [
      '=HYPERLINK("http://evil","x")',
      '@Корт; 2',
    ]);
    const charged = await seedBooking(club, {
      start: '2026-10-19T16:00:00Z',
      totalCents: 3333,
      court: 0,
    });
    await seedBooking(club, { start: '2026-10-19T16:00:00Z', totalCents: 2400, court: 1 });
    await sweep(new Date('2026-10-20T00:00:00Z'));
    await asAppUser(db, club.tenant.tenantId, (tx) =>
      markNoShow(tx, club.tenant.tenantId, {
        bookingId: charged.id,
        actorUserId: club.tenant.userId,
        now: new Date('2026-10-21T09:00:00Z'),
      }),
    );

    const res = await clubGet(
      csvRoute,
      club.tenant.tenantSlug,
      club.owner,
      '2026-10',
      'statements/csv',
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect(res.headers.get('content-disposition')).toBe(
      `attachment; filename="playerz-${club.tenant.tenantSlug}-2026-10.csv"`,
    );
    expect(res.headers.get('cache-control')).toBe('private, no-store');

    const bytes = new Uint8Array(await res.arrayBuffer());
    // EF BB BF: the UTF-8 byte-order mark, so Excel reads Cyrillic.
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const text = new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes).slice(1);
    const rows = text.split('\r\n');
    expect(rows.at(-1)).toBe('');
    expect(rows[0]).toBe(
      'Дата;Час;Обект;Корт;Вид;Цена (EUR);Такса %;Безплатен период;Такса (EUR);Резервация',
    );
    // 19 October 19:00 in Sofia, both courts, then the correction.
    expect(rows.slice(1, -1)).toEqual([
      `19.10.2026;19:00;Обект Изток;"'=HYPERLINK(""http://evil"",""x"")";Игра;33,33;12,50;Не;4,17;${charged.id}`,
      expect.stringMatching(
        /^19\.10\.2026;19:00;Обект Изток;"'@Корт; 2";Игра;24,00;12,50;Не;3,00;\w+$/,
      ),
      `19.10.2026;19:00;Обект Изток;"'=HYPERLINK(""http://evil"",""x"")";Корекция;-33,33;12,50;Не;-4,17;${charged.id}`,
    ]);
  });
});

// ══ The platform ══════════════════════════════════════════════════════════

describe('the platform fee pages', () => {
  let admin: string;
  let granter: string;

  const uid = (p: string) => `${p}${randomUUID().replace(/-/g, '').slice(0, 21)}`;

  beforeEach(async () => {
    admin = uid('fadm');
    granter = uid('fgrn');
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
           (id,"userId","grantedByUserId",reason,capabilities,"expiresAt")
         VALUES ($1,$2,$3,'club fee invoicing rota',$4::"PlatformCapability"[], now() + interval '7 days')`,
        uid('fg'),
        admin,
        granter,
        `{${caps.join(',')}}`,
      ),
    );
  }

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

  const overview = (bearer: string, month: string, reason = REASON) =>
    overviewRoute(
      new NextRequest(
        `http://t/api/v1/platform/fees?month=${month}&reason=${encodeURIComponent(reason)}`,
        { headers: { authorization: `Bearer ${bearer}` } },
      ),
      {},
    ).then(read);

  const setTerms = (bearer: string, clubId: string, body: Record<string, unknown>) =>
    termsRoute(
      new NextRequest(`http://t/api/v1/platform/fees/${clubId}/terms`, {
        method: 'PUT',
        headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ clubId }) },
    ).then(read);

  const auditRows = (action: string) =>
    asAppSuperuser(db, (tx) => tx.platformAuditEntry.findMany({ where: { action }, take: 20 }));

  it('lists every club with this month’s fee due, and links each statement and CSV', async () => {
    await grant([PlatformCapability.TENANT_READ]);
    const a = await seedClub({ feePercent: '10' });
    const b = await seedClub({ feePercent: '5', feeStartsOn: '2026-12-01' });
    await seedBooking(a, { start: '2026-10-19T10:00:00Z' });
    await seedBooking(b, { start: '2026-10-19T10:00:00Z' });
    await sweep(new Date('2026-10-20T00:00:00Z'));
    const bearer = await bearerFor(admin);

    const { status, body } = await overview(bearer, '2026-10');
    expect(status).toBe(200);
    type Row = {
      club: { id: string };
      feePercent: string;
      feeStartsOn: string;
      freePeriod: string;
      totals: Record<string, number>;
    };
    const clubs = (body.data as { clubs: Row[] }).clubs;
    const rowA = clubs.find((c) => c.club.id === a.tenant.tenantId)!;
    const rowB = clubs.find((c) => c.club.id === b.tenant.tenantId)!;
    expect(rowA).toMatchObject({ feePercent: '10.00', freePeriod: 'none' });
    expect(rowA.totals).toEqual({
      bookingsPlayed: 1,
      revenueCents: 2400,
      feeCents: 240,
      lineCount: 1,
    });
    expect(rowB).toMatchObject({
      feePercent: '5.00',
      feeStartsOn: '2026-12-01',
      freePeriod: 'all',
    });
    expect(rowB.totals.feeCents).toBe(0);
    expect(await auditRows('PLATFORM_FEE_OVERVIEW_READ')).toHaveLength(1);

    const statement = await platformStatementRoute(
      new NextRequest(
        `http://t/api/v1/platform/fees/${a.tenant.tenantId}/statement?month=2026-10&reason=${encodeURIComponent(REASON)}`,
        { headers: { authorization: `Bearer ${bearer}` } },
      ),
      { params: Promise.resolve({ clubId: a.tenant.tenantId }) },
    ).then(read);
    expect(statement.status).toBe(200);
    expect((statement.body.data as { totals: { feeCents: number } }).totals.feeCents).toBe(240);

    const csv = await platformCsvRoute(
      new NextRequest(
        `http://t/api/v1/platform/fees/${a.tenant.tenantId}/statement/csv?month=2026-10&reason=${encodeURIComponent(REASON)}`,
        { headers: { authorization: `Bearer ${bearer}` } },
      ),
      { params: Promise.resolve({ clubId: a.tenant.tenantId }) },
    );
    expect(csv.status).toBe(200);
    expect((await csv.text()).split('\r\n')).toHaveLength(3); // header, one line, final CRLF
    const reads = await auditRows('PLATFORM_FEE_STATEMENT_READ');
    expect(reads.map((r) => r.subjectTenantId)).toEqual([a.tenant.tenantId, a.tenant.tenantId]);
  });

  it('needs a grant with TENANT_READ and a stated reason to read', async () => {
    const bearer = await bearerFor(admin);
    expect((await overview(bearer, '2026-10')).status).toBe(403);
    await grant([PlatformCapability.REVIEW_MODERATE]);
    expect((await overview(bearer, '2026-10')).body.error?.code).toBe(
      'PLATFORM_CAPABILITY_REQUIRED',
    );
    expect((await overview(bearer, '2026-10', 'short')).status).toBe(400);
  });

  it('a fee change without a step-up is refused and leaves nothing behind', async () => {
    await grant([PlatformCapability.TENANT_READ, PlatformCapability.CLUB_FEE_MANAGE]);
    const club = await seedClub({ feePercent: '10' });
    const body = {
      feePercent: '12.5',
      feeStartsOn: '2027-01-01',
      reason: 'pilot deal agreed 2026-10-07',
    };

    // Not enrolled at all.
    const unenrolled = await setTerms(await bearerFor(admin), club.tenant.tenantId, body);
    expect(unenrolled.status).toBe(403);
    expect(unenrolled.body.error?.code).toBe('MFA_ENROLMENT_REQUIRED');

    // Enrolled on one session; a second session has not stepped up.
    await enrolAndStepUp(await bearerFor(admin));
    const notStepped = await setTerms(await bearerFor(admin), club.tenant.tenantId, body);
    expect(notStepped.status).toBe(403);
    expect(notStepped.body.error?.code).toBe('STEP_UP_REQUIRED');

    const org = await asAppSuperuser(db, (tx) =>
      tx.venueOrg.findUniqueOrThrow({ where: { id: club.tenant.tenantId } }),
    );
    expect(org.feePercent.toString()).toBe('10');
    expect(await auditRows('PLATFORM_CLUB_FEE_TERMS_SET')).toEqual([]);
  });

  it('a grant without CLUB_FEE_MANAGE cannot change a fee, even stepped up', async () => {
    await grant([PlatformCapability.TENANT_READ]);
    const club = await seedClub();
    const bearer = await bearerFor(admin);
    await enrolAndStepUp(bearer);
    const res = await setTerms(bearer, club.tenant.tenantId, {
      feePercent: '12',
      feeStartsOn: '2027-01-01',
      reason: 'pilot deal agreed 2026-10-07',
    });
    expect(res.status).toBe(403);
    expect(res.body.error?.code).toBe('PLATFORM_CAPABILITY_REQUIRED');
  });

  it('stepped up, sets the terms, audits both sides, and only later lines see them', async () => {
    await grant([PlatformCapability.TENANT_READ, PlatformCapability.CLUB_FEE_MANAGE]);
    const club = await seedClub({ feePercent: '10' });
    const earlier = await seedBooking(club, { start: '2026-10-19T10:00:00Z' });
    await sweep(new Date('2026-10-19T12:00:00Z'));

    const bearer = await bearerFor(admin);
    await enrolAndStepUp(bearer);

    const bad = await setTerms(bearer, club.tenant.tenantId, {
      feePercent: '30.5',
      feeStartsOn: '2027-01-01',
      reason: 'pilot deal agreed 2026-10-07',
    });
    expect(bad.status).toBe(400);
    const badDate = await setTerms(bearer, club.tenant.tenantId, {
      feePercent: '12',
      feeStartsOn: '2027-02-30',
      reason: 'pilot deal agreed 2026-10-07',
    });
    expect(badDate.status).toBe(400);

    const ok = await setTerms(bearer, club.tenant.tenantId, {
      feePercent: '12.5',
      feeStartsOn: '2026-01-01',
      reason: 'pilot deal agreed 2026-10-07',
    });
    expect(ok.status).toBe(200);
    expect(ok.body.data).toMatchObject({
      changed: true,
      before: { feePercent: '10.00', feeStartsOn: '2026-01-01' },
      after: { feeBps: 1250, feePercent: '12.50', feeStartsOn: '2026-01-01' },
    });

    const platformRows = await auditRows('PLATFORM_CLUB_FEE_TERMS_SET');
    expect(platformRows).toHaveLength(1);
    expect(platformRows[0]).toMatchObject({
      subjectTenantId: club.tenant.tenantId,
      capability: 'CLUB_FEE_MANAGE',
      reason: 'pilot deal agreed 2026-10-07',
    });
    const clubRows = await asAppSuperuser(db, (tx) =>
      tx.auditEntry.findMany({
        where: { tenantId: club.tenant.tenantId, action: 'CLUB_FEE_TERMS_CHANGED' },
        take: 5,
      }),
    );
    expect(clubRows).toHaveLength(1);
    expect(clubRows[0]!.actorUserId).toBe(admin);
    expect(clubRows[0]!.detailsJson).toMatchObject({
      before: { feePercent: '10.00' },
      after: { feePercent: '12.50' },
    });

    // The same again: nothing changes club-side.
    const again = await setTerms(bearer, club.tenant.tenantId, {
      feePercent: 12.5,
      feeStartsOn: '2026-01-01',
      reason: 'pilot deal agreed 2026-10-07',
    });
    expect((again.body.data as { changed: boolean }).changed).toBe(false);

    const later = await seedBooking(club, { start: '2026-10-19T14:00:00Z' });
    await sweep(new Date('2026-10-20T00:00:00Z'));
    expect((await linesOf(earlier.id))[0]!.feeCents).toBe(240);
    expect((await linesOf(later.id))[0]!.feeCents).toBe(300);

    const missing = await setTerms(bearer, 'no-such-club', {
      feePercent: '1',
      feeStartsOn: '2027-01-01',
      reason: 'pilot deal agreed 2026-10-07',
    });
    expect(missing.status).toBe(404);
  });
});
