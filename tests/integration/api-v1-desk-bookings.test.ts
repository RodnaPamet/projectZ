import { formatInTimeZone } from 'date-fns-tz';
import { NextRequest } from 'next/server';

import { GET as myBookingsRoute } from '@/app/api/v1/me/bookings/route';
import { GET as customersRoute } from '@/app/api/v1/t/[slug]/admin/customers/route';
import { POST as seriesCancelRoute } from '@/app/api/v1/t/[slug]/admin/booking-series/[id]/cancel/route';
import { GET as seriesGetRoute } from '@/app/api/v1/t/[slug]/admin/booking-series/[id]/route';
import { POST as seriesRoute } from '@/app/api/v1/t/[slug]/admin/booking-series/route';
import {
  GET as deskGetRoute,
  PATCH as deskPatchRoute,
} from '@/app/api/v1/t/[slug]/admin/desk-bookings/[id]/route';
import { GET as previewRoute } from '@/app/api/v1/t/[slug]/admin/desk-bookings/preview/route';
import { POST as deskRoute } from '@/app/api/v1/t/[slug]/admin/desk-bookings/route';
import { POST as cancelRoute } from '@/app/api/v1/t/[slug]/bookings/[id]/cancel/route';
import { POST as playerBookRoute } from '@/app/api/v1/t/[slug]/bookings/route';

import { seedPlayer, signInAs, type TestIdentity } from '../helpers/auth';
import {
  prismaTestClient,
  resetDatabase,
  seedAccount,
  seedTenant,
  type SeededTenant,
} from '../helpers/db';
import { asAppSuperuser } from '../helpers/rls';

/**
 * DESK BOOKINGS AND WEEKLY SERIES (#364), through the real routes against a
 * real database: staff book for a name and phone, optionally linked to one of
 * the club's players; a series books the same court every week, all or
 * nothing; and every write is audited.
 */

const ZONE = 'Europe/Sofia';

type Json = {
  data?: Record<string, unknown> & { id?: string };
  error?: { code: string; message: string; details?: Record<string, unknown> };
};

interface Club {
  tenant: SeededTenant;
  resourceId: string;
  staff: TestIdentity;
}

describe('desk bookings and weekly series (#364)', () => {
  const db = prismaTestClient();

  /** A club with one court, open 08:00–22:00 every day at the club, 60-minute units. */
  async function seedClub(): Promise<Club> {
    const tenant = await seedTenant({}, db);
    const resourceId = await asAppSuperuser(db, async (tx) => {
      const venue = await tx.venue.create({
        data: {
          tenantId: tenant.tenantId,
          slug: `desk-${tenant.tenantId.slice(-8)}`,
          name: 'Desk Club',
          addressLine: '1 Court St',
          city: 'Sofia',
          email: 'internal@club.test',
          lat: 42.6977,
          lng: 23.3219,
          timezone: ZONE,
        },
      });
      const r = await tx.resource.create({
        data: {
          tenantId: tenant.tenantId,
          venueId: venue.id,
          name: 'Корт 1',
          sport: 'PADEL',
          surface: 'HARD',
          basePriceCents: 2400,
          minBookingMinutes: 60,
          maxBookingMinutes: 180,
          slotStepMinutes: 60,
        },
      });
      await tx.resourceAvailability.createMany({
        data: Array.from({ length: 7 }, (_, dayOfWeek) => ({
          tenantId: tenant.tenantId,
          resourceId: r.id,
          dayOfWeek,
          openTime: new Date('1970-01-01T08:00:00Z'),
          closeTime: new Date('1970-01-01T22:00:00Z'),
        })),
      });
      return r.id;
    });

    const staffId = await seedAccount('CLUB', db);
    await asAppSuperuser(db, (tx) =>
      tx.tenantMembership.create({
        data: { tenantId: tenant.tenantId, userId: staffId, role: 'STAFF', status: 'ACTIVE' },
      }),
    );
    const staff = await signInAs(db, {
      userId: staffId,
      memberships: [{ tenantId: tenant.tenantId, tenantSlug: tenant.tenantSlug, role: 'STAFF' }],
    });
    return { tenant, resourceId, staff };
  }

  let club: Club;
  let other: Club;
  let player: TestIdentity;

  beforeEach(async () => {
    await resetDatabase(db);
    club = await seedClub();
    other = await seedClub();
    const playerId = await seedPlayer(db, club.tenant.tenantId);
    player = await signInAs(db, {
      userId: playerId,
      memberships: [
        { tenantId: club.tenant.tenantId, tenantSlug: club.tenant.tenantSlug, role: 'PLAYER' },
      ],
    });
  });

  // ─── request helpers ────────────────────────────────────────────────

  const url = (slug: string, path: string) => `http://t/api/v1/t/${slug}/admin/${path}`;
  const headers = (who: TestIdentity, key?: string) => ({
    authorization: `Bearer ${who.bearer}`,
    'content-type': 'application/json',
    ...(key ? { 'idempotency-key': key } : {}),
  });
  const read = async (res: Response) => ({ status: res.status, body: (await res.json()) as Json });

  const desk = (
    body: Record<string, unknown>,
    opts: { who?: TestIdentity; slug?: string; key?: string } = {},
  ) => {
    const slug = opts.slug ?? club.tenant.tenantSlug;
    return deskRoute(
      new NextRequest(url(slug, 'desk-bookings'), {
        method: 'POST',
        headers: headers(opts.who ?? club.staff, opts.key ?? `k-${Math.random()}`),
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ slug }) },
    ).then(read);
  };

  const series = (
    body: Record<string, unknown>,
    opts: { who?: TestIdentity; key?: string } = {},
  ) => {
    const slug = club.tenant.tenantSlug;
    return seriesRoute(
      new NextRequest(url(slug, 'booking-series'), {
        method: 'POST',
        headers: headers(opts.who ?? club.staff, opts.key ?? `k-${Math.random()}`),
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ slug }) },
    ).then(read);
  };

  const preview = (query: Record<string, string | number>) => {
    const slug = club.tenant.tenantSlug;
    const qs = new URLSearchParams(Object.entries(query).map(([k, v]) => [k, String(v)]));
    return previewRoute(
      new NextRequest(`${url(slug, 'desk-bookings/preview')}?${qs}`, {
        headers: headers(club.staff),
      }),
      { params: Promise.resolve({ slug }) },
    ).then(read);
  };

  const getDesk = (id: string, opts: { who?: TestIdentity; slug?: string } = {}) => {
    const slug = opts.slug ?? club.tenant.tenantSlug;
    return deskGetRoute(
      new NextRequest(url(slug, `desk-bookings/${id}`), {
        headers: headers(opts.who ?? club.staff),
      }),
      { params: Promise.resolve({ slug, id }) },
    ).then(read);
  };

  const patchDesk = (id: string, body: Record<string, unknown>) => {
    const slug = club.tenant.tenantSlug;
    return deskPatchRoute(
      new NextRequest(url(slug, `desk-bookings/${id}`), {
        method: 'PATCH',
        headers: headers(club.staff),
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ slug, id }) },
    ).then(read);
  };

  const cancelOne = (id: string, who: TestIdentity = club.staff) => {
    const slug = club.tenant.tenantSlug;
    return cancelRoute(
      new NextRequest(`http://t/api/v1/t/${slug}/bookings/${id}/cancel`, {
        method: 'POST',
        headers: headers(who),
      }),
      { params: Promise.resolve({ slug, id }) },
    ).then(read);
  };

  const cancelSeries = (id: string, fromDate: string) => {
    const slug = club.tenant.tenantSlug;
    return seriesCancelRoute(
      new NextRequest(url(slug, `booking-series/${id}/cancel`), {
        method: 'POST',
        headers: headers(club.staff),
        body: JSON.stringify({ fromDate }),
      }),
      { params: Promise.resolve({ slug, id }) },
    ).then(read);
  };

  const customers = (q: string, who: TestIdentity = club.staff) => {
    const slug = club.tenant.tenantSlug;
    return customersRoute(
      new NextRequest(`${url(slug, 'customers')}?q=${encodeURIComponent(q)}`, {
        headers: headers(who),
      }),
      { params: Promise.resolve({ slug }) },
    ).then(read);
  };

  const slot = (date: string, startTime = '10:00', durationMinutes = 60) => ({
    resourceId: club.resourceId,
    date,
    startTime,
    durationMinutes,
  });
  const walkIn = { name: 'Иван Петров', phone: '0888 123 456' };

  const audit = (action: string) =>
    asAppSuperuser(db, (tx) =>
      tx.auditEntry.findMany({ where: { tenantId: club.tenant.tenantId, action } }),
    );
  const rows = () =>
    asAppSuperuser(db, (tx) =>
      tx.booking.findMany({
        where: { tenantId: club.tenant.tenantId },
        orderBy: { startTs: 'asc' },
      }),
    );

  // ─── single desk booking ────────────────────────────────────────────

  it('books for a name and phone with no account: DESK, CONFIRMED, quoted, audited', async () => {
    const { status, body } = await desk({
      ...slot('2036-07-16'),
      customer: walkIn,
      notes: 'плаща в брой',
    });

    expect(status).toBe(201);
    expect(body.data).toMatchObject({
      status: 'CONFIRMED',
      channel: 'DESK',
      date: '2036-07-16',
      startTime: '10:00',
      endTime: '11:00',
      // July in Sofia is UTC+3.
      startTs: '2036-07-16T07:00:00Z',
      totalCents: 2400,
      notes: 'плаща в брой',
      customer: { name: 'Иван Петров', phone: '+359888123456' },
      player: null,
      series: null,
    });

    const [row] = await rows();
    expect(row).toMatchObject({
      channel: 'DESK',
      status: 'CONFIRMED',
      bookedByUserId: null,
      guestName: 'Иван Петров',
      guestPhone: '+359888123456',
      expiresAt: null,
    });

    const created = await audit('DESK_BOOKING_CREATED');
    expect(created).toHaveLength(1);
    expect(created[0]!.actorUserId).toBe(club.staff.userId);
    expect(await audit('DESK_PRICE_OVERRIDDEN')).toHaveLength(0);
  });

  it('a repeated Idempotency-Key returns the same booking (200), and writes nothing twice', async () => {
    const first = await desk({ ...slot('2036-07-16'), customer: walkIn }, { key: 'same' });
    const again = await desk({ ...slot('2036-07-16'), customer: walkIn }, { key: 'same' });
    expect(first.status).toBe(201);
    expect(again.status).toBe(200);
    expect(again.body.data!.id).toBe(first.body.data!.id);
    expect(await rows()).toHaveLength(1);
    expect(await audit('DESK_BOOKING_CREATED')).toHaveLength(1);
  });

  it('a desk key can never replay a player’s online booking', async () => {
    const slug = club.tenant.tenantSlug;
    const online = await playerBookRoute(
      new NextRequest(`http://t/api/v1/t/${slug}/bookings`, {
        method: 'POST',
        headers: headers(player, 'shared-key'),
        body: JSON.stringify({
          resourceId: club.resourceId,
          startTs: '2036-07-16T07:00:00Z',
          endTs: '2036-07-16T08:00:00Z',
        }),
      }),
      { params: Promise.resolve({ slug }) },
    );
    expect(online.status).toBe(201);

    const deskSame = await desk(
      { ...slot('2036-07-16', '12:00'), customer: walkIn },
      { key: 'shared-key' },
    );
    expect(deskSame.status).toBe(201);
    expect(deskSame.body.data!.startTime).toBe('12:00');
  });

  it('linked to one of the club’s players, it appears in that player’s /me/bookings', async () => {
    const { status, body } = await desk({
      ...slot('2036-07-16'),
      customer: { ...walkIn, userId: player.userId },
    });
    expect(status).toBe(201);
    expect(body.data!.player).toMatchObject({ id: player.userId, name: 'Test Player' });

    const res = await myBookingsRoute(
      new NextRequest('http://t/api/v1/me/bookings', {
        headers: { authorization: `Bearer ${player.bearer}` },
      }),
      { params: Promise.resolve({}) },
    );
    const page = (await res.json()) as { data: { items: Array<Record<string, unknown>> } };
    expect(page.data.items.map((b) => b.id)).toEqual([body.data!.id]);
    // The club's notes and the customer's phone are the club's, not the player's.
    expect(JSON.stringify(page.data.items[0])).not.toContain('+359888123456');
  });

  it('refuses to link somebody who is not this club’s player, as 404 PLAYER_NOT_FOUND', async () => {
    const elsewhere = await seedPlayer(db, other.tenant.tenantId);
    for (const userId of [elsewhere, 'no-such-user']) {
      const { status, body } = await desk({
        ...slot('2036-07-16'),
        customer: { ...walkIn, userId },
      });
      expect(status).toBe(404);
      expect(body.error!.code).toBe('PLAYER_NOT_FOUND');
    }
    expect(await rows()).toHaveLength(0);
  });

  it('is exempt from the online cap, the no-show block and the past-start rule', async () => {
    await asAppSuperuser(db, async (tx) => {
      await tx.venueOrg.update({
        where: { id: club.tenant.tenantId },
        data: { maxUpcomingOnlineBookings: 1 },
      });
      // Three recent no-shows: online booking is blocked for this player.
      for (const d of [1, 2, 3]) {
        await tx.booking.create({
          data: {
            tenantId: club.tenant.tenantId,
            resourceId: club.resourceId,
            bookedByUserId: player.userId,
            startTs: new Date(Date.now() - d * 86_400_000),
            endTs: new Date(Date.now() - d * 86_400_000 + 3_600_000),
            status: 'NO_SHOW',
            totalCents: 2400,
            idempotencyKey: `ns-${d}`,
          },
        });
      }
    });

    const slug = club.tenant.tenantSlug;
    const online = await playerBookRoute(
      new NextRequest(`http://t/api/v1/t/${slug}/bookings`, {
        method: 'POST',
        headers: headers(player, 'online'),
        body: JSON.stringify({
          resourceId: club.resourceId,
          startTs: '2036-07-16T07:00:00Z',
          endTs: '2036-07-16T08:00:00Z',
        }),
      }),
      { params: Promise.resolve({ slug }) },
    ).then(read);
    expect(online.body.error!.code).toBe('NO_SHOW_BLOCKED');

    const linked = { ...walkIn, userId: player.userId };
    expect((await desk({ ...slot('2036-07-16', '10:00'), customer: linked })).status).toBe(201);
    expect((await desk({ ...slot('2036-07-16', '11:00'), customer: linked })).status).toBe(201);

    // A walk-in for the hour already under way: an hour that started at the
    // club two hours ago, yesterday's date at worst.
    const started = new Date(Date.now() - 2 * 3_600_000);
    const date = formatInTimeZone(started, ZONE, 'yyyy-MM-dd');
    const hour = formatInTimeZone(started, ZONE, 'HH');
    // Only inside opening hours: otherwise yesterday at 10:00.
    const inHours = Number(hour) >= 8 && Number(hour) <= 20;
    const past = inHours
      ? slot(date, `${hour}:00`)
      : slot(formatInTimeZone(new Date(Date.now() - 86_400_000), ZONE, 'yyyy-MM-dd'), '10:00');
    const walk = await desk({ ...past, customer: linked });
    expect(walk.status).toBe(201);
    expect(walk.body.data!.status).toBe('CONFIRMED');
  });

  it('meets the same overlap constraint as an online booking: 409 SLOT_TAKEN', async () => {
    expect((await desk({ ...slot('2036-07-16'), customer: walkIn })).status).toBe(201);
    const clash = await desk({ ...slot('2036-07-16', '10:00', 120), customer: walkIn });
    expect(clash.status).toBe(409);
    expect(clash.body.error!.code).toBe('SLOT_TAKEN');
  });

  it('keeps the court’s hours: a closed time is 400 SLOT_NOT_BOOKABLE', async () => {
    const res = await desk({ ...slot('2036-07-16', '22:00'), customer: walkIn });
    expect(res.status).toBe(400);
    expect(res.body.error!.code).toBe('SLOT_NOT_BOOKABLE');
  });

  it('audits a price override with the quote and the price', async () => {
    const { status, body } = await desk({
      ...slot('2036-07-16'),
      customer: walkIn,
      priceCents: 1500,
    });
    expect(status).toBe(201);
    expect(body.data!.totalCents).toBe(1500);

    const [entry] = await audit('DESK_PRICE_OVERRIDDEN');
    expect(entry).toBeDefined();
    expect(entry!.entityId).toBe(body.data!.id);
    expect(entry!.actorUserId).toBe(club.staff.userId);
    expect(entry!.detailsJson).toMatchObject({ quotedCents: 2400, priceCents: 1500 });
  });

  it('validates the body strictly: a bad phone, an unknown property', async () => {
    const badPhone = await desk({
      ...slot('2036-07-16'),
      customer: { name: 'X', phone: 'call me' },
    });
    expect(badPhone.status).toBe(400);
    expect(badPhone.body.error!.details).toMatchObject({ field: 'customer.phone' });

    const typo = await desk({ ...slot('2036-07-16'), customer: walkIn, price: 100 });
    expect(typo.status).toBe(400);
  });

  // ─── permissions and tenancy ────────────────────────────────────────

  it('403 for a member without bookings.view_all (a coach), and for a player — on every verb', async () => {
    const coachId = await seedAccount('COACH', db);
    await asAppSuperuser(db, (tx) =>
      tx.tenantMembership.create({
        data: { tenantId: club.tenant.tenantId, userId: coachId, role: 'COACH', status: 'ACTIVE' },
      }),
    );
    const coach = await signInAs(db, {
      userId: coachId,
      memberships: [
        { tenantId: club.tenant.tenantId, tenantSlug: club.tenant.tenantSlug, role: 'COACH' },
      ],
    });
    const made = await desk({ ...slot('2036-07-16'), customer: walkIn });

    for (const who of [coach, player]) {
      const post = await desk({ ...slot('2036-07-16', '12:00'), customer: walkIn }, { who });
      expect(post.status).toBe(403);
      expect(post.body.error).toMatchObject({
        code: 'FORBIDDEN',
        details: { requiredPermission: 'bookings.view_all' },
      });
      expect(
        (
          await series(
            { ...slot('2036-07-16', '12:00'), repeat: { weeks: 2 }, customer: walkIn },
            { who },
          )
        ).status,
      ).toBe(403);
      expect((await getDesk(made.body.data!.id!, { who })).status).toBe(403);
      expect((await customers('Test', who)).status).toBe(403);
    }
    expect(await rows()).toHaveLength(1);
  });

  it('no IDOR across clubs: another club’s staff cannot read or edit this club’s desk booking', async () => {
    const made = await desk({ ...slot('2036-07-16'), customer: walkIn });
    const id = made.body.data!.id!;

    // Through their own club's slug: the booking is invisible under RLS.
    const theirs = await getDesk(id, { who: other.staff, slug: other.tenant.tenantSlug });
    expect(theirs.status).toBe(404);
    // Through this club's slug: not a member here.
    const here = await getDesk(id, { who: other.staff });
    expect(here.status).toBe(403);
    // And they cannot book on this club's court from their own slug.
    const book = await desk(
      { ...slot('2036-07-16', '12:00'), customer: walkIn },
      { who: other.staff, slug: other.tenant.tenantSlug },
    );
    expect(book.status).toBe(404);
  });

  // ─── customers ──────────────────────────────────────────────────────

  it('matches a phone only among this club’s players, and never returns the phone', async () => {
    await asAppSuperuser(db, (tx) =>
      tx.user.update({ where: { id: player.userId }, data: { phone: '+359 888 123 456' } }),
    );
    // Somebody else on playerz with the same number, who never played here.
    const stranger = await seedPlayer(db, other.tenant.tenantId);
    await asAppSuperuser(db, (tx) =>
      tx.user.update({ where: { id: stranger }, data: { phone: '0888123456' } }),
    );

    const here = await customers('0888 123 456');
    expect(here.status).toBe(200);
    const items = here.body.data as unknown as Array<Record<string, unknown>>;
    expect(items.map((m) => m.userId)).toEqual([player.userId]);
    expect(items[0]).toMatchObject({ matchedBy: 'phone' });
    expect(JSON.stringify(items)).not.toContain('888');

    // The other club's staff, asking the same number at THEIR club, learn
    // nothing about this club's player.
    const slug = other.tenant.tenantSlug;
    const there = await customersRoute(
      new NextRequest(`${url(slug, 'customers')}?q=0888123456`, { headers: headers(other.staff) }),
      { params: Promise.resolve({ slug }) },
    ).then(read);
    expect((there.body.data as unknown as Array<{ userId: string }>).map((m) => m.userId)).toEqual([
      stranger,
    ]);
  });

  it('remembers a phone the desk linked before', async () => {
    await desk({
      ...slot('2036-07-16'),
      customer: { name: 'Иван', phone: '+359 87 7000 111', userId: player.userId },
    });
    const found = await customers('0877000111');
    expect((found.body.data as unknown as Array<{ userId: string }>).map((m) => m.userId)).toEqual([
      player.userId,
    ]);
  });

  // ─── edit ───────────────────────────────────────────────────────────

  it('edits the customer and links an account; refuses an online booking and a cancelled one', async () => {
    const made = await desk({ ...slot('2036-07-16'), customer: walkIn });
    const id = made.body.data!.id!;

    const edited = await patchDesk(id, {
      customer: { name: 'Иван П.', phone: '0899 000 000', userId: player.userId },
    });
    expect(edited.status).toBe(200);
    expect(edited.body.data).toMatchObject({
      customer: { name: 'Иван П.', phone: '+359899000000' },
      player: { id: player.userId },
    });
    expect(await audit('DESK_BOOKING_UPDATED')).toHaveLength(1);

    expect((await cancelOne(id)).status).toBe(200);
    const late = await patchDesk(id, { notes: 'x' });
    expect(late.status).toBe(409);
    expect(late.body.error!.code).toBe('BOOKING_NOT_EDITABLE');
  });

  // ─── series ─────────────────────────────────────────────────────────

  it('previews 4 weeks with the clashing week, then refuses the series whole until it is skipped', async () => {
    // Wednesday 2036-07-30, 10:00, is already taken.
    expect(
      (await desk({ ...slot('2036-07-30'), customer: { name: 'Друг', phone: '0888000000' } }))
        .status,
    ).toBe(201);

    const rule = { ...slot('2036-07-16'), repeat: { weeks: 4 } };
    const pv = await preview({ ...slot('2036-07-16'), weeks: 4 });
    expect(pv.status).toBe(200);
    const occurrences = (
      pv.body.data as unknown as {
        occurrences: Array<{ date: string; status: string; quotedCents: number }>;
      }
    ).occurrences;
    expect(occurrences.map((o) => [o.date, o.status])).toEqual([
      ['2036-07-16', 'free'],
      ['2036-07-23', 'free'],
      ['2036-07-30', 'taken'],
      ['2036-08-06', 'free'],
    ]);
    expect(occurrences.every((o) => o.quotedCents === 2400)).toBe(true);

    const refused = await series({ ...rule, customer: walkIn });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatchObject({
      code: 'SERIES_CLASH',
      details: { clashes: [{ date: '2036-07-30', reason: 'taken' }] },
    });
    // Nothing written: one booking (the clash), no series.
    expect(await rows()).toHaveLength(1);
    expect(await asAppSuperuser(db, (tx) => tx.bookingSeries.count())).toBe(0);

    const made = await series({ ...rule, customer: walkIn, skipDates: ['2036-07-30'] });
    expect(made.status).toBe(201);
    const s = made.body.data as unknown as {
      id: string;
      occurrences: Array<{ date: string; status: string }>;
      firstDate: string;
      lastDate: string;
    };
    expect(s.occurrences.map((o) => o.date)).toEqual(['2036-07-16', '2036-07-23', '2036-08-06']);
    expect(s.occurrences.every((o) => o.status === 'CONFIRMED')).toBe(true);
    expect([s.firstDate, s.lastDate]).toEqual(['2036-07-16', '2036-08-06']);

    const inSeries = (await rows()).filter((r) => r.seriesId === s.id);
    expect(inSeries).toHaveLength(3);
    expect(inSeries.every((r) => r.channel === 'DESK' && r.guestPhone === '+359888123456')).toBe(
      true,
    );

    const created = await audit('BOOKING_SERIES_CREATED');
    expect(created).toHaveLength(1);
    expect(created[0]!.detailsJson).toMatchObject({ skipped: ['2036-07-30'] });

    // The detail of one occurrence names its series.
    const one = await getDesk(inSeries[0]!.id);
    expect(one.body.data!.series).toMatchObject({ id: s.id, remaining: 3, startTime: '10:00' });
  });

  it('keeps the wall-clock time across the end of summer time in Sofia', async () => {
    // Tuesdays 19:00 at the club: 27 Oct 2026 is before the change (UTC+3),
    // 3 Nov after it (UTC+2). The change is Sunday 25 Oct 2026.
    const made = await series({
      ...slot('2026-10-20', '19:00'),
      repeat: { until: '2026-11-03' },
      customer: walkIn,
    });
    expect(made.status).toBe(201);
    const occ = (
      made.body.data as unknown as { occurrences: Array<{ date: string; startTs: string }> }
    ).occurrences;
    expect(occ).toEqual([
      expect.objectContaining({ date: '2026-10-20', startTs: '2026-10-20T16:00:00Z' }),
      expect.objectContaining({ date: '2026-10-27', startTs: '2026-10-27T17:00:00Z' }),
      expect.objectContaining({ date: '2026-11-03', startTs: '2026-11-03T17:00:00Z' }),
    ]);
  });

  it('a preview with a bad parameter names it; a preview for a closed hour is unavailable', async () => {
    const bad = await preview({ ...slot('2036-07-16'), weeks: 0 });
    expect(bad.status).toBe(400);
    expect(bad.body.error!.details).toMatchObject({ field: 'weeks' });

    const closed = await preview({ ...slot('2036-07-16', '21:30') });
    const occ = (
      closed.body.data as unknown as { occurrences: Array<{ status: string; quotedCents: null }> }
    ).occurrences;
    expect(occ).toEqual([expect.objectContaining({ status: 'unavailable', quotedCents: null })]);
  });

  it('refuses a series longer than a year, and one that ends before it starts', async () => {
    const long = await series({
      ...slot('2036-01-07'),
      repeat: { until: '2037-06-01' },
      customer: walkIn,
    });
    expect(long.body.error!.code).toBe('INVALID_SERIES');
    const back = await series({
      ...slot('2036-07-16'),
      repeat: { until: '2036-07-01' },
      customer: walkIn,
    });
    expect(back.body.error!.code).toBe('INVALID_SERIES');
    const weeks = await series({ ...slot('2036-07-16'), repeat: { weeks: 53 }, customer: walkIn });
    expect(weeks.status).toBe(400);
  });

  it('two desks racing for the same weeks: one series, one 409, never half of either', async () => {
    const rule = { ...slot('2036-07-16'), repeat: { weeks: 4 }, customer: walkIn };
    const [a, b] = await Promise.all([series(rule), series({ ...rule, startTime: '10:00' })]);

    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([201, 409]);
    const loser = a.status === 409 ? a : b;
    expect(['SERIES_CLASH', 'SLOT_TAKEN']).toContain(loser.body.error!.code);

    const all = await rows();
    expect(all).toHaveLength(4);
    expect(new Set(all.map((r) => r.seriesId)).size).toBe(1);
    expect(await asAppSuperuser(db, (tx) => tx.bookingSeries.count())).toBe(1);
  });

  it('cancels one week on its own, then the rest of the series from a date', async () => {
    const made = await series({ ...slot('2036-07-16'), repeat: { weeks: 4 }, customer: walkIn });
    const s = made.body.data as unknown as {
      id: string;
      occurrences: Array<{ bookingId: string; date: string }>;
    };

    // One week alone, through the ordinary staff cancel.
    expect((await cancelOne(s.occurrences[1]!.bookingId)).status).toBe(200);

    const cut = await cancelSeries(s.id, '2036-07-30');
    expect(cut.status).toBe(200);
    const after = cut.body.data as unknown as {
      cancelledFrom: string;
      occurrences: Array<{ date: string; status: string }>;
    };
    expect(after.cancelledFrom).toBe('2036-07-30');
    expect(after.occurrences.map((o) => [o.date, o.status])).toEqual([
      ['2036-07-16', 'CONFIRMED'],
      ['2036-07-23', 'CANCELLED'],
      ['2036-07-30', 'CANCELLED'],
      ['2036-08-06', 'CANCELLED'],
    ]);

    // Every cancelled week has its receipt and its own audit row; the series one more.
    const cancels = await asAppSuperuser(db, (tx) =>
      tx.cancellation.count({ where: { tenantId: club.tenant.tenantId } }),
    );
    expect(cancels).toBe(3);
    expect(await audit('BOOKING_CANCELLED')).toHaveLength(3);
    const seriesCut = await audit('BOOKING_SERIES_CANCELLED');
    expect(seriesCut).toHaveLength(1);
    expect(seriesCut[0]!.actorUserId).toBe(club.staff.userId);

    // Harmless to repeat.
    expect((await cancelSeries(s.id, '2036-07-30')).status).toBe(200);
    expect(await audit('BOOKING_CANCELLED')).toHaveLength(3);

    // And the freed weeks are bookable again.
    expect((await desk({ ...slot('2036-07-30'), customer: walkIn })).status).toBe(201);
  });

  it('applies a customer change to the rest of the series', async () => {
    const made = await series({ ...slot('2036-07-16'), repeat: { weeks: 3 }, customer: walkIn });
    const s = made.body.data as unknown as {
      id: string;
      occurrences: Array<{ bookingId: string }>;
    };

    const res = await patchDesk(s.occurrences[1]!.bookingId, {
      customer: { ...walkIn, userId: player.userId },
      applyToSeries: true,
    });
    expect(res.status).toBe(200);

    const linked = (await rows()).map((r) => r.bookedByUserId);
    expect(linked).toEqual([null, player.userId, player.userId]);

    const slug = club.tenant.tenantSlug;
    const got = await seriesGetRoute(
      new NextRequest(url(slug, `booking-series/${s.id}`), { headers: headers(club.staff) }),
      { params: Promise.resolve({ slug, id: s.id }) },
    ).then(read);
    expect((got.body.data as unknown as { customer: { userId: string } }).customer.userId).toBe(
      player.userId,
    );
  });
});
