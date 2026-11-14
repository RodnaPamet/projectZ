import { NextRequest } from 'next/server';

import { POST as cron } from '@/app/api/cron/sync-calendars/route';
import { GET as callback } from '@/app/api/integrations/google-calendar/callback/route';
import { DELETE as disconnect } from '@/app/api/v1/me/calendar/google/route';
import { POST as connect } from '@/app/api/v1/me/calendar/google/connect/route';
import { POST as syncNow } from '@/app/api/v1/me/calendar/google/sync/route';
import { GET as status } from '@/app/api/v1/me/calendar/route';
import { DELETE as deleteMe } from '@/app/api/v1/me/route';

import { seedPlayer, signInAs, type TestIdentity } from '../helpers/auth';
import {
  prismaTestClient,
  seedTenant,
  seedVenue,
  withTenant,
  type SeededTenant,
} from '../helpers/db';
import { FakeGoogle } from '../helpers/fake-google-calendar';
import { asAppSuperuser } from '../helpers/rls';

/**
 * Google Calendar sync per player (owner 2026-11-14), end to end on a real
 * database with Google faked: connect → callback → first sync; a booking change
 * marks the person dirty in the same transaction and the loop syncs it; an
 * event edited by hand is left alone; a cancelled booking is removed;
 * invalid_grant → REVOKED; switching off and deleting the account revoke.
 */
const db = prismaTestClient();
const HOUR = 3_600_000;

type Handler = (
  req: NextRequest,
  ctx: { params: Promise<Record<string, string>> },
) => Promise<Response>;

async function call(
  route: Handler,
  method: string,
  path: string,
  opts: { who?: TestIdentity | null; body?: unknown; headers?: Record<string, string> } = {},
) {
  const headers: Record<string, string> = { ...opts.headers };
  if (opts.who) headers.authorization = `Bearer ${opts.who.bearer}`;
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  return route(
    new NextRequest(`http://localhost:3000${path}`, {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    }),
    { params: Promise.resolve({}) },
  );
}

const json = async <T>(res: Response) => (await res.json()) as T;

function booking(
  tenantId: string,
  resourceId: string,
  start: Date,
  data: Record<string, unknown> = {},
) {
  return asAppSuperuser(db, (tx) =>
    tx.booking.create({
      data: {
        tenantId,
        resourceId,
        startTs: start,
        endTs: new Date(start.getTime() + HOUR),
        totalCents: 2400,
        status: 'CONFIRMED',
        idempotencyKey: `k-${Math.random()}`,
        ...data,
      },
      select: { id: true },
    }),
  );
}

const connection = (userId: string) =>
  asAppSuperuser(db, (tx) => tx.googleCalendarConnection.findUnique({ where: { userId } }));

describe('Google Calendar sync (owner 2026-11-14)', () => {
  const env = { ...process.env };
  let g: FakeGoogle;
  let club: SeededTenant;
  let court: { venueId: string; resourceId: string };
  let player: TestIdentity;
  let fetchSpy: jest.SpyInstance;

  /** The switch on, through Google, as the phone does it. */
  async function connectAs(who: TestIdentity, client: 'ios' | 'web' = 'ios') {
    const res = await call(connect as Handler, 'POST', '/api/v1/me/calendar/google/connect', {
      who,
      body: { client },
    });
    expect(res.status).toBe(200);
    const { data } = await json<{ data: { authorizeUrl: string } }>(res);
    const state = new URL(data.authorizeUrl).searchParams.get('state')!;
    return { state, authorizeUrl: data.authorizeUrl };
  }
  const back = (state: string, extra = '&code=the-code', who: TestIdentity | null = null) =>
    call(
      callback as Handler,
      'GET',
      `/api/integrations/google-calendar/callback?state=${encodeURIComponent(state)}${extra}`,
      { who },
    );
  const runCron = () =>
    call(cron as Handler, 'POST', '/api/cron/sync-calendars', {
      headers: { 'x-cron-secret': 'cron-secret-for-tests' },
    });

  beforeEach(async () => {
    process.env.GOOGLE_CALENDAR_SYNC = '1';
    process.env.GOOGLE_CLIENT_ID = 'test-client.apps.googleusercontent.com';
    process.env.GOOGLE_CLIENT_SECRET = 'test-secret';
    process.env.APP_URL = 'http://localhost:3000';
    process.env.CRON_SECRET = 'cron-secret-for-tests';
    g = new FakeGoogle();
    fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(g.fetch);

    club = await seedTenant({});
    court = await seedVenue(club.tenantId, { name: 'Клуб Юг' });
    const userId = await seedPlayer(db, club.tenantId, 'cal');
    player = await signInAs(db, {
      userId,
      memberships: [{ tenantId: club.tenantId, tenantSlug: club.tenantSlug, role: 'PLAYER' }],
    });
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    process.env = { ...env };
  });

  it('switched off: every route is 404 GOOGLE_CALENDAR_SYNC_DISABLED, and the loop does nothing', async () => {
    process.env.GOOGLE_CALENDAR_SYNC = '0';
    const res = await call(status as Handler, 'GET', '/api/v1/me/calendar', { who: player });
    expect(res.status).toBe(404);
    expect((await json<{ error: { code: string } }>(res)).error.code).toBe(
      'GOOGLE_CALENDAR_SYNC_DISABLED',
    );
    const c = await call(connect as Handler, 'POST', '/api/v1/me/calendar/google/connect', {
      who: player,
      body: { client: 'ios' },
    });
    expect(c.status).toBe(404);
    expect(await json(await runCron())).toEqual({ synced: 0, failed: 0, revoked: 0, states: 0 });
  });

  it('connect → callback → first sync, then status; the state is single-use', async () => {
    const b = await booking(club.tenantId, court.resourceId, new Date(Date.now() + 24 * HOUR), {
      bookedByUserId: player.userId,
    });
    const { state, authorizeUrl } = await connectAs(player);
    const url = new URL(authorizeUrl);
    expect(url.searchParams.get('redirect_uri')).toBe(
      'http://localhost:3000/api/integrations/google-calendar/callback',
    );
    expect(url.searchParams.get('scope')).toContain('calendar.app.created');

    const res = await back(state);
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(
      'bg.playerz.app://integrations/google-calendar?result=connected',
    );

    const row = await connection(player.userId);
    expect(row).toMatchObject({
      status: 'ACTIVE',
      googleEmail: 'player@gmail.test',
      dirtyAt: null,
    });
    // Ciphertext, never the token itself.
    expect(row!.refreshTokenEnc).toMatch(/^v1:/);
    expect(row!.refreshTokenEnc).not.toContain('rt-');
    expect(g.calendars.get(row!.calendarId!)?.summary).toBe('playerz');
    const events = g.events();
    expect(events).toHaveLength(1);
    expect(events[0]!.summary).toBe('Резервация · Клуб Юг');
    expect(events[0]!.extendedProperties?.private?.playerzId).toBe(`booking:${b.id}`);

    const s = await json<{ data: unknown }>(
      await call(status as Handler, 'GET', '/api/v1/me/calendar', { who: player }),
    );
    expect(s.data).toEqual({
      google: {
        connected: true,
        email: 'player@gmail.test',
        lastSyncAt: expect.any(String),
        lastResult: {
          created: 1,
          updated: 0,
          deleted: 0,
          unchanged: 0,
          skippedEdited: 0,
          partial: false,
        },
        error: null,
      },
    });

    // The same state a second time is the replay the nonce exists to refuse.
    const again = await back(state);
    expect(again.headers.get('location')).toBe(
      'bg.playerz.app://integrations/google-calendar?error=state_invalid',
    );
    // And a state nobody issued goes to the web page, never the app scheme.
    const unknown = await back('made-up');
    expect(unknown.headers.get('location')).toBe(
      'http://localhost:3000/me/profile?googleCalendar=state_invalid',
    );
  });

  it('declined, or the calendar box unticked: a closed error code, nothing stored', async () => {
    const declined = await connectAs(player);
    const res = await back(declined.state, '&error=access_denied');
    expect(res.headers.get('location')).toBe(
      'bg.playerz.app://integrations/google-calendar?error=access_denied',
    );

    g.grantScopes = 'openid email https://www.googleapis.com/auth/calendar.freebusy';
    const partial = await connectAs(player);
    const res2 = await back(partial.state);
    expect(res2.headers.get('location')).toBe(
      'bg.playerz.app://integrations/google-calendar?error=insufficient_scope',
    );
    expect(g.revoked).toHaveLength(1);
    expect(await connection(player.userId)).toBeNull();
  });

  it('the web flow returns to the profile, and only for the person who started it', async () => {
    const other = await signInAs(db, {
      userId: await seedPlayer(db, club.tenantId, 'other'),
      memberships: [{ tenantId: club.tenantId, tenantSlug: club.tenantSlug, role: 'PLAYER' }],
    });
    const stolen = await connectAs(player, 'web');
    const res = await back(stolen.state, '&code=c', other);
    expect(res.headers.get('location')).toBe(
      'http://localhost:3000/me/profile?googleCalendar=state_invalid',
    );
    expect(await connection(player.userId)).toBeNull();

    const mine = await connectAs(player, 'web');
    const ok = await back(mine.state, '&code=c', player);
    expect(ok.headers.get('location')).toBe(
      'http://localhost:3000/me/profile?googleCalendar=connected',
    );
  });

  it('a booking change marks the person dirty in its own transaction, and the loop syncs it', async () => {
    const start = new Date(Date.now() + 48 * HOUR);
    const b = await booking(club.tenantId, court.resourceId, start, {
      bookedByUserId: player.userId,
    });
    await back((await connectAs(player)).state);
    expect((await connection(player.userId))!.dirtyAt).toBeNull();

    // Moved by the club, bound to the club as a use case would be: the trigger
    // reaches the person's row although the writer cannot see it.
    const moved = new Date(start.getTime() + 2 * HOUR);
    await withTenant(club.tenantId, (tx) =>
      tx.booking.update({
        where: { id: b.id },
        data: { startTs: moved, endTs: new Date(moved.getTime() + HOUR) },
      }),
    );
    expect((await connection(player.userId))!.dirtyAt).not.toBeNull();

    // An added player who is not connected changes nothing for anyone else.
    const res = await runCron();
    expect(await json(res)).toMatchObject({ synced: 1, failed: 0, revoked: 0 });
    expect((await connection(player.userId))!.dirtyAt).toBeNull();
    expect(Date.parse(g.events()[0]!.start.dateTime)).toBe(
      Math.floor(moved.getTime() / 1000) * 1000,
    );

    // A run with nothing due touches nobody.
    expect(await json(await runCron())).toMatchObject({ synced: 0 });

    // Being added to someone else's booking marks them too.
    const other = await booking(club.tenantId, court.resourceId, new Date(Date.now() + 72 * HOUR), {
      bookedByUserId: club.userId,
    });
    await withTenant(club.tenantId, (tx) =>
      tx.bookingParticipant.create({
        data: { tenantId: club.tenantId, bookingId: other.id, userId: player.userId, position: 2 },
      }),
    );
    expect((await connection(player.userId))!.dirtyAt).not.toBeNull();
    await runCron();
    expect(g.events()).toHaveLength(2);
  });

  it('a cancelled booking is removed; an event edited by hand is left alone', async () => {
    const kept = await booking(club.tenantId, court.resourceId, new Date(Date.now() + 24 * HOUR), {
      bookedByUserId: player.userId,
    });
    const gone = await booking(club.tenantId, court.resourceId, new Date(Date.now() + 30 * HOUR), {
      bookedByUserId: player.userId,
    });
    await back((await connectAs(player)).state);
    const byId = (id: string) =>
      g.events().find((e) => e.extendedProperties?.private?.playerzId === `booking:${id}`);
    expect(byId(kept.id)).toBeDefined();

    // The person renames one event in Google.
    g.editTitle(byId(kept.id)!.id, 'Мачът с Иван');
    // The club cancels both bookings.
    for (const id of [kept.id, gone.id]) {
      await withTenant(club.tenantId, (tx) =>
        tx.booking.update({
          where: { id },
          data: { status: 'CANCELLED', cancelledAt: new Date() },
        }),
      );
    }

    const res = await call(syncNow as Handler, 'POST', '/api/v1/me/calendar/google/sync', {
      who: player,
    });
    expect(res.status).toBe(200);
    expect((await json<{ data: unknown }>(res)).data).toEqual({
      created: 0,
      updated: 0,
      deleted: 1,
      unchanged: 0,
      skippedEdited: 1,
      partial: false,
    });
    expect(byId(gone.id)).toBeUndefined();
    expect(byId(kept.id)?.summary).toBe('Мачът с Иван');
  });

  it('invalid_grant marks the connection REVOKED: «Свържете отново»', async () => {
    await back((await connectAs(player)).state);
    g.revokeAll();

    const res = await call(syncNow as Handler, 'POST', '/api/v1/me/calendar/google/sync', {
      who: player,
    });
    expect(res.status).toBe(409);
    expect((await json<{ error: { code: string } }>(res)).error.code).toBe(
      'GOOGLE_CALENDAR_REVOKED',
    );
    expect((await connection(player.userId))!.status).toBe('REVOKED');

    const s = await json<{ data: { google: unknown } }>(
      await call(status as Handler, 'GET', '/api/v1/me/calendar', { who: player }),
    );
    expect(s.data.google).toMatchObject({ connected: false, error: 'GOOGLE_REVOKED' });

    // The loop leaves a revoked connection alone; reconnecting brings it back.
    expect(await json(await runCron())).toMatchObject({ synced: 0, revoked: 0 });
    await back((await connectAs(player)).state);
    expect((await connection(player.userId))!.status).toBe('ACTIVE');
  });

  it('the switch off revokes at Google and forgets the grant; the calendar stays in Google', async () => {
    await booking(club.tenantId, court.resourceId, new Date(Date.now() + 24 * HOUR), {
      bookedByUserId: player.userId,
    });
    await back((await connectAs(player)).state);
    const res = await call(disconnect as Handler, 'DELETE', '/api/v1/me/calendar/google', {
      who: player,
    });
    expect(res.status).toBe(204);
    expect(await connection(player.userId)).toBeNull();
    expect(g.revoked).toEqual(['rt-1']);
    expect(g.events()).toHaveLength(1);
    // Twice is fine.
    expect(
      (await call(disconnect as Handler, 'DELETE', '/api/v1/me/calendar/google', { who: player }))
        .status,
    ).toBe(204);
  });

  it('deleting the account removes the connection and revokes the grant', async () => {
    await back((await connectAs(player)).state);
    const res = await call(deleteMe as Handler, 'DELETE', '/api/v1/me', { who: player });
    expect(res.status).toBe(204);
    expect(await connection(player.userId)).toBeNull();
    expect(g.revoked).toEqual(['rt-1']);
    expect(
      await asAppSuperuser(db, (tx) =>
        tx.calendarOAuthState.count({ where: { userId: player.userId } }),
      ),
    ).toBe(0);
  });

  it('nobody reads another person’s connection: owner-only at the database', async () => {
    await back((await connectAs(player)).state);
    const seen = await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SELECT set_config('app.user_id', $1, true)`, club.userId);
      await tx.$executeRawUnsafe(`SET LOCAL ROLE app_user`);
      return tx.googleCalendarConnection.count();
    });
    expect(seen).toBe(0);
  });
});
