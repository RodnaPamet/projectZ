import { formatInTimeZone, fromZonedTime } from 'date-fns-tz';
import { NextRequest } from 'next/server';

import {
  AnthropicUnavailableError,
  completeWithClaude,
  type Completion,
} from '@/app-layer/ai/anthropic';
import { deleteMyAccount } from '@/app-layer/usecases/account-deletion';
import { POST as cron } from '@/app/api/cron/assistant-memory/route';
import { POST as ask } from '@/app/api/v1/assistant/stream/route';
import {
  DELETE as forgetPoint,
  PATCH as editPoint,
} from '@/app/api/v1/me/assistant-memory/[id]/route';
import { DELETE as forgetAll, GET as listMemory } from '@/app/api/v1/me/assistant-memory/route';
import {
  DELETE as deleteConversation,
  GET as getConversation,
} from '@/app/api/v1/me/assistant-conversations/[id]/route';
import { GET as listConversations } from '@/app/api/v1/me/assistant-conversations/route';
import { encryptField } from '@/lib/security/encryption';

import { seedPlayer, signInAs, type TestIdentity } from '../helpers/auth';
import { prismaTestClient, seedTenant, type SeededTenant } from '../helpers/db';
import { FakeGoogle } from '../helpers/fake-google-calendar';
import { asAppSuperuser } from '../helpers/rls';

jest.mock('@/app-layer/ai/anthropic', () => ({
  ...jest.requireActual('@/app-layer/ai/anthropic'),
  completeWithClaude: jest.fn(),
}));
const model = completeWithClaude as jest.MockedFunction<typeof completeWithClaude>;

/**
 * «Асистент» against a real database (owner 2026-11-14, #704), with Claude
 * and Google faked: the stream's events and drafts, the two tools over real
 * venues, bookings and calendars, the privacy of best_time_for_game, the
 * daily cap, and the memory and conversation routes with their rules.
 */
const db = prismaTestClient();
const TZ = 'Europe/Sofia';
const HOUR = 3_600_000;
const tomorrow = formatInTimeZone(new Date(Date.now() + 86_400_000), TZ, 'yyyy-MM-dd');
const local = (hhmm: string, day = tomorrow) => fromZonedTime(`${day}T${hhmm}:00`, TZ);

type Handler = (
  req: NextRequest,
  ctx: { params: Promise<Record<string, string>> },
) => Promise<Response>;

function call(
  route: Handler,
  method: string,
  path: string,
  who: TestIdentity | null,
  body?: unknown,
  params: Record<string, string> = {},
  extra: Record<string, string> = {},
) {
  const headers: Record<string, string> = { ...extra };
  if (who) headers.authorization = `Bearer ${who.bearer}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  return route(
    new NextRequest(`http://localhost:3000${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    { params: Promise.resolve(params) },
  );
}

interface Event {
  type: string;
  [k: string]: unknown;
}

async function stream(
  who: TestIdentity,
  body: Record<string, unknown>,
): Promise<{ status: number; events: Event[]; error?: { code: string } }> {
  const res = await call(ask as Handler, 'POST', '/api/v1/assistant/stream', who, body);
  if (res.status !== 200)
    return {
      status: res.status,
      events: [],
      error: ((await res.json()) as { error: { code: string } }).error,
    };
  expect(res.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
  const text = await res.text();
  const events = text
    .split('\n\n')
    .filter((c) => c.startsWith('data: '))
    .map((c) => JSON.parse(c.slice(6)) as Event);
  return { status: 200, events };
}

const usage = { inputTokens: 2000, outputTokens: 300, cacheReadTokens: 0, cacheWriteTokens: 0 };
const toolCall = (name: string, input: unknown): Completion => ({
  content: [{ type: 'tool_use', id: `tu-${name}`, name, input }],
  text: '',
  toolUses: [{ id: `tu-${name}`, name, input }],
  stopReason: 'tool_use',
  model: 'claude-opus-5-5',
  usage,
});
const say = (text: string): Completion => ({
  content: [{ type: 'text', text }],
  text,
  toolUses: [],
  stopReason: 'end_turn',
  model: 'claude-opus-5-5',
  usage,
});

/** The tool result the model was handed on its second call, parsed. */
function toolResultSeen(callIndex = 1): { content: string; is_error?: boolean } {
  const req = model.mock.calls[callIndex]![0];
  const last = req.messages[req.messages.length - 1]!;
  return (last.content as Array<{ content: string; is_error?: boolean }>)[0]!;
}

describe('«Асистент» (owner 2026-11-14, #704)', () => {
  const env = { ...process.env };
  let club: SeededTenant;
  let venueId: string;
  let courtId: string;
  let me: TestIdentity;
  let g: FakeGoogle;
  let fetchSpy: jest.SpyInstance;

  const sign = async (name: string) => {
    const id = await seedPlayer(db, club.tenantId, 'ai');
    await asAppSuperuser(db, (tx) => tx.user.update({ where: { id }, data: { name } }));
    return signInAs(db, {
      userId: id,
      memberships: [{ tenantId: club.tenantId, tenantSlug: club.tenantSlug, role: 'PLAYER' }],
    });
  };

  const booking = (start: Date, data: Record<string, unknown>) =>
    asAppSuperuser(db, (tx) =>
      tx.booking.create({
        data: {
          tenantId: club.tenantId,
          resourceId: courtId,
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

  beforeEach(async () => {
    process.env.ASSISTANT_ENABLED = '1';
    process.env.ANTHROPIC_API_KEY = 'test-key';
    process.env.CRON_SECRET = 'cron-for-tests';
    delete process.env.ASSISTANT_DAILY_SPEND_CAP_USD;
    model.mockReset();
    g = new FakeGoogle();
    fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(g.fetch);

    club = await seedTenant({});
    const seeded = await asAppSuperuser(db, async (tx) => {
      const venue = await tx.venue.create({
        data: {
          tenantId: club.tenantId,
          slug: `ai-club-${Math.random().toString(36).slice(2, 8)}`,
          name: 'Падел Юг',
          addressLine: '1 Court St',
          city: 'Sofia',
          email: 'internal@club.test',
          lat: 42.6977,
          lng: 23.3219,
          timezone: TZ,
        },
      });
      const court = await tx.resource.create({
        data: {
          tenantId: club.tenantId,
          venueId: venue.id,
          name: 'Корт 1',
          sport: 'PADEL',
          surface: 'HARD',
          basePriceCents: 2400,
          minBookingMinutes: 60,
          slotStepMinutes: 60,
        },
      });
      for (let d = 0; d < 7; d++) {
        await tx.resourceAvailability.create({
          data: {
            tenantId: club.tenantId,
            resourceId: court.id,
            dayOfWeek: d,
            openTime: new Date('1970-01-01T08:00:00Z'),
            closeTime: new Date('1970-01-01T22:00:00Z'),
          },
        });
      }
      return { venueId: venue.id, courtId: court.id };
    });
    venueId = seeded.venueId;
    courtId = seeded.courtId;
    me = await sign('Иво');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    process.env = { ...env };
  });

  it('switched off: every route is 404 ASSISTANT_DISABLED, and the model is never called', async () => {
    process.env.ASSISTANT_ENABLED = '0';
    expect(await stream(me, { message: 'Здрасти' })).toMatchObject({
      status: 404,
      error: { code: 'ASSISTANT_DISABLED' },
    });
    for (const [route, path] of [
      [listMemory, '/api/v1/me/assistant-memory'],
      [listConversations, '/api/v1/me/assistant-conversations'],
    ] as const) {
      const res = await call(route as Handler, 'GET', path, me);
      expect(res.status).toBe(404);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
        'ASSISTANT_DISABLED',
      );
    }
    expect(model).not.toHaveBeenCalled();
  });

  it('signed out is 401; a bad body is 400', async () => {
    const res = await call(ask as Handler, 'POST', '/api/v1/assistant/stream', null, {
      message: 'x',
    });
    expect(res.status).toBe(401);
    expect((await stream(me, { message: 'x', page: { screen: 'nowhere' } })).status).toBe(400);
    expect((await stream(me, { message: 'x', extra: 1 })).status).toBe(400);
  });

  it('find_free_places: the events in order, a free hour with its price, and a booking draft', async () => {
    model
      .mockResolvedValueOnce(
        toolCall('find_free_places', {
          sport: 'PADEL',
          city: 'София',
          dateFrom: tomorrow,
          dateTo: tomorrow,
          timeFrom: '18:00',
          timeTo: '21:00',
        }),
      )
      .mockResolvedValueOnce(say('Утре в 18:00 има свободен корт в Падел Юг за 24 €.'));
    await booking(local('19:00'), {}); // 19:00 is taken

    const { status, events } = await stream(me, {
      message: 'Има ли свободен падел утре вечер?',
      page: { screen: 'home' },
      location: { lat: 42.123456, lng: 23.654321 },
    });
    expect(status).toBe(200);
    expect(events.map((e) => e.type)).toEqual([
      'conversation',
      'thinking',
      'tool_call',
      'tool_result',
      'answer',
      'done',
    ]);
    expect(events[3]).toEqual({
      type: 'tool_result',
      name: 'find_free_places',
      ok: true,
      truncated: false,
    });
    expect(events[4]).toEqual({
      type: 'answer',
      text: 'Утре в 18:00 има свободен корт в Падел Юг за 24 €.',
      proposal: {
        kind: 'booking',
        draft: {
          venueId,
          resourceId: courtId,
          startTs: local('18:00').toISOString(),
          endTs: local('19:00').toISOString(),
        },
      },
    });
    expect(events[5]).toEqual({ type: 'done', truncatedAny: false, partialAny: false });

    const result = JSON.parse(toolResultSeen().content) as {
      places: Array<{ local: string; priceCents: number }>;
    };
    expect(result.places.map((p) => p.local.slice(-5))).toEqual(['18:00', '20:00']);
    expect(result.places[0]!.priceCents).toBe(2400);

    // The model saw the rules, the tools, today — and never the location.
    const first = model.mock.calls[0]![0];
    expect(first.tools!.map((t) => t.name).sort()).toEqual([
      'best_time_for_game',
      'find_free_places',
      'propose_booking',
      'search_past_conversations',
    ]);
    expect(first.system).toMatch(/informally, with «ти»/);
    expect(JSON.stringify(first.messages)).not.toContain('42.12');
    expect(JSON.stringify(first.messages)).toContain(
      `today: ${formatInTimeZone(new Date(), TZ, 'yyyy-MM-dd')}`,
    );

    // Charged, and the exchange recorded under the conversation it named.
    const conversationId = events[0]!.conversationId as string;
    const [spend, turns] = await asAppSuperuser(db, (tx) =>
      Promise.all([
        tx.assistantSpend.findMany({ where: { userId: me.userId } }),
        tx.assistantTurn.findMany({ where: { conversationId }, orderBy: { createdAt: 'asc' } }),
      ]),
    );
    expect(spend[0]).toMatchObject({ calls: 2 });
    expect(spend[0]!.costMicros).toBeGreaterThan(0);
    expect(turns.map((t) => t.role)).toEqual(['user', 'assistant']);

    // The next question continues it, with the earlier turns fenced as history.
    model.mockResolvedValueOnce(say('Да, в 18:00.'));
    const next = await stream(me, { message: 'А 18:00 още ли е свободно?', conversationId });
    expect(next.events[0]).toEqual({ type: 'conversation', conversationId });
    const replay = JSON.stringify(model.mock.calls[2]![0].messages);
    expect(replay).toContain('CONVERSATION_HISTORY');
    expect(replay).toContain('Има ли свободен падел утре вечер?');
  });

  it('propose_booking: the person picks another option; it is checked again, and a taken hour is refused', async () => {
    const pick = (hhmm: string) => ({
      kind: 'booking',
      venueId,
      resourceId: courtId,
      startTs: local(hhmm).toISOString(),
      endTs: new Date(local(hhmm).getTime() + HOUR).toISOString(),
    });
    await booking(local('19:00'), {});
    model
      .mockResolvedValueOnce(toolCall('propose_booking', pick('20:00')))
      .mockResolvedValueOnce(say('Подготвих 20:00.'))
      .mockResolvedValueOnce(toolCall('propose_booking', pick('19:00')))
      .mockResolvedValueOnce(say('19:00 вече е заето.'));
    const ok = await stream(me, { message: 'Дай 20:00' });
    expect(ok.events.find((e) => e.type === 'answer')).toEqual({
      type: 'answer',
      text: 'Подготвих 20:00.',
      proposal: {
        kind: 'booking',
        draft: {
          venueId,
          resourceId: courtId,
          startTs: pick('20:00').startTs,
          endTs: pick('20:00').endTs,
        },
      },
    });
    const taken = await stream(me, { message: 'Тогава 19:00' });
    expect(taken.events.find((e) => e.type === 'tool_result')).toMatchObject({ ok: false });
    expect(taken.events.find((e) => e.type === 'answer')).not.toHaveProperty('proposal');
  });

  it('near the person, when the app shared where they are', async () => {
    model
      .mockResolvedValueOnce(
        toolCall('find_free_places', {
          sport: 'PADEL',
          near: true,
          dateFrom: tomorrow,
          dateTo: tomorrow,
        }),
      )
      .mockResolvedValueOnce(say('Близо до теб: Падел Юг.'));
    await stream(me, {
      message: 'Корт близо до мен утре?',
      location: { lat: 42.6977, lng: 23.3219 },
    });
    const r = JSON.parse(toolResultSeen().content) as {
      places: Array<{ venueId: string; distanceKm: number }>;
    };
    expect(r.places[0]).toMatchObject({ venueId, distanceKm: 0 });
  });

  describe('best_time_for_game', () => {
    let ana: TestIdentity;
    let boris: TestIdentity;
    let gameBookingId: string;

    beforeEach(async () => {
      process.env.GOOGLE_CALENDAR_SYNC = '1';
      process.env.GOOGLE_CLIENT_ID = 'test-client.apps.googleusercontent.com';
      process.env.GOOGLE_CLIENT_SECRET = 'test-secret';
      ana = await sign('Ана');
      boris = await sign('Борис');
      gameBookingId = (await booking(local('10:00'), { bookedByUserId: me.userId })).id;
      await asAppSuperuser(db, async (tx) => {
        await tx.bookingParticipant.create({
          data: {
            tenantId: club.tenantId,
            bookingId: gameBookingId,
            userId: ana.userId,
            position: 2,
          },
        });
        await tx.bookingParticipant.create({
          data: {
            tenantId: club.tenantId,
            bookingId: gameBookingId,
            userId: boris.userId,
            position: 3,
          },
        });
        // Ана's Google Calendar is connected: busy 18:00–19:00 tomorrow.
        await tx.googleCalendarConnection.create({
          data: {
            userId: ana.userId,
            refreshTokenEnc: encryptField('rt-ana'),
            scopes: [],
            status: 'ACTIVE',
          },
        });
        // Mine too, free.
        await tx.googleCalendarConnection.create({
          data: {
            userId: me.userId,
            refreshTokenEnc: encryptField('rt-me'),
            scopes: [],
            status: 'ACTIVE',
          },
        });
      });
      g.liveRefreshTokens.add('rt-ana');
      g.liveRefreshTokens.add('rt-me');
      g.primaryBusyByToken['rt-ana'] = [
        { start: local('18:00').toISOString(), end: local('19:00').toISOString() },
      ];
      // Борис has no calendar connected, and plays somewhere at 19:00.
      await asAppSuperuser(db, (tx) =>
        tx.resource.create({
          data: {
            tenantId: club.tenantId,
            venueId,
            name: 'Корт 2',
            sport: 'TENNIS',
            surface: 'HARD',
            basePriceCents: 1000,
          },
        }),
      ).then((other) =>
        asAppSuperuser(db, (tx) =>
          tx.booking.create({
            data: {
              tenantId: club.tenantId,
              resourceId: other.id,
              startTs: local('19:00'),
              endTs: local('20:00'),
              totalCents: 1000,
              status: 'CONFIRMED',
              idempotencyKey: `k-${Math.random()}`,
              bookedByUserId: boris.userId,
            },
          }),
        ),
      );
    });

    const askBest = (bookingId: string) => {
      model
        .mockResolvedValueOnce(
          toolCall('best_time_for_game', {
            bookingId,
            dateFrom: tomorrow,
            dateTo: tomorrow,
            timeFrom: '18:00',
            timeTo: '21:00',
          }),
        )
        .mockResolvedValueOnce(say('Най-добре в 20:00.'));
      return stream(me, {
        message: 'Кога можем да играем пак утре вечер?',
        page: { screen: 'booking', bookingId },
      });
    };

    it('drops the times somebody is busy, says who is unknown, and proposes the best', async () => {
      const { events } = await askBest(gameBookingId);
      const result = JSON.parse(toolResultSeen().content) as {
        players: Array<{ name: string; calendar: string; why?: string }>;
        options: Array<{
          local: string;
          everyoneFree: boolean;
          free: string[];
          unknown: Array<{ name: string; why: string }>;
        }>;
        proposalKind: string;
      };
      // 18:00 — Ана is busy in Google; 19:00 — Борис plays then. 20:00 is left.
      expect(result.options.map((o) => o.local.slice(-5))).toEqual(['20:00']);
      expect(result.options[0]).toMatchObject({
        everyoneFree: false,
        free: ['you', 'Ана'],
        unknown: [{ name: 'Борис', why: 'no Google Calendar connected' }],
      });
      expect(result.players).toEqual([
        { name: 'you', calendar: 'known' },
        { name: 'Ана', calendar: 'known' },
        { name: 'Борис', calendar: 'unknown', why: 'no Google Calendar connected' },
      ]);
      // Busy or free only: no interval of anybody's reaches the model.
      expect(toolResultSeen().content).not.toContain(local('18:00').toISOString());
      expect(events.find((e) => e.type === 'answer')).toMatchObject({
        proposal: {
          kind: 'booking',
          draft: { venueId, resourceId: courtId, startTs: local('20:00').toISOString() },
        },
      });
    });

    it('an open game is proposed as a game, with what it asks for', async () => {
      await asAppSuperuser(db, (tx) =>
        tx.openGame.create({
          data: { tenantId: club.tenantId, bookingId: gameBookingId, spotsWanted: 1, levelMin: 3 },
        }),
      );
      const { events } = await askBest(gameBookingId);
      expect(events.find((e) => e.type === 'answer')).toMatchObject({
        proposal: {
          kind: 'game',
          draft: { spots: 1, levelMin: 3, startTs: local('20:00').toISOString() },
        },
      });
    });

    it('a booking the asker is not on reads as nothing: a failed tool, no names', async () => {
      const theirs = (await booking(local('12:00'), { bookedByUserId: ana.userId })).id;
      const { events } = await askBest(theirs);
      expect(events.find((e) => e.type === 'tool_result')).toMatchObject({ ok: false });
      expect(toolResultSeen()).toMatchObject({
        is_error: true,
        content: 'that is not one of the person’s bookings',
      });
      expect(events.find((e) => e.type === 'answer')).not.toHaveProperty('proposal');
    });
  });

  it('the daily cap: a halt with its reason, and the model is not called', async () => {
    process.env.ASSISTANT_DAILY_SPEND_CAP_USD = '0';
    const { events } = await stream(me, { message: 'Корт утре?' });
    expect(events.map((e) => e.type)).toEqual(['conversation', 'thinking', 'halt', 'done']);
    expect(events[2]).toMatchObject({
      code: 'ASSISTANT_SPEND_CEILING',
      message: expect.stringMatching(/лимита/),
    });
    expect(model).not.toHaveBeenCalled();
  });

  it('the model unreachable: a halt saying so, in the account’s language, then done', async () => {
    await asAppSuperuser(db, (tx) =>
      tx.user.update({ where: { id: me.userId }, data: { locale: 'en' } }),
    );
    model.mockRejectedValueOnce(new AnthropicUnavailableError('HTTP 529', 529));
    const { events } = await stream(me, { message: 'Court tomorrow?' });
    expect(events.slice(-2)).toEqual([
      {
        type: 'halt',
        code: 'ASSISTANT_PROVIDER_UNAVAILABLE',
        message: expect.stringMatching(/not answering/),
      },
      { type: 'done', truncatedAny: false, partialAny: false },
    ]);
    expect(model.mock.calls[0]![0].system).toMatch(/Answer in English/);
  });

  it('memory: learns only the person’s own words; edit, forget and forget-all keep their promises', async () => {
    model.mockResolvedValueOnce(say('Приятно ми е, Иво!'));
    const first = await stream(me, { message: 'Казвам се Иво и играя падел.' });
    const later = new Date(Date.now() + 11 * 60_000);
    const extraction = (points: unknown[]): Completion => ({
      ...say(JSON.stringify({ points })),
      model: 'claude-haiku-5-5',
    });
    model.mockResolvedValueOnce(
      extraction([
        { text: 'Казва се Иво.', sourceQuote: 'Казвам се Иво', supersedesId: null },
        { text: 'Свободен е в събота.', sourceQuote: 'свободен в събота', supersedesId: null },
      ]),
    );
    const { runMemorySweep } = await import('@/app-layer/usecases/assistant-memory-sweep');
    expect(await runMemorySweep({ now: later })).toEqual({ read: 1, learned: 1, skipped: 0 });
    expect(model.mock.calls[1]![0]).toMatchObject({ model: 'claude-haiku-5-5' });
    // Only the person's question was read, never the answer.
    expect(model.mock.calls[1]![0].system).not.toContain('Приятно ми е');

    const list = async () =>
      (
        (await (
          await call(listMemory as Handler, 'GET', '/api/v1/me/assistant-memory', me)
        ).json()) as {
          data: { items: Array<{ id: string; text: string; editedByPerson: boolean }> };
        }
      ).data.items;
    const items = await list();
    expect(items).toEqual([
      {
        id: expect.any(String),
        text: 'Казва се Иво.',
        rememberedAt: expect.any(String),
        editedByPerson: false,
      },
    ]);
    expect(JSON.stringify(items)).not.toContain('Казвам се Иво'); // the evidence stays on the server

    // The profile reaches the next answer, fenced as data.
    model.mockResolvedValueOnce(say('Здрасти, Иво.'));
    await stream(me, { message: 'Здрасти' });
    expect(JSON.stringify(model.mock.calls[2]![0].messages)).toContain('REMEMBERED_PROFILE_START');

    const id = items[0]!.id;
    const edited = await call(
      editPoint as Handler,
      'PATCH',
      `/api/v1/me/assistant-memory/${id}`,
      me,
      { text: 'Викат ме Иво.' },
      { id },
    );
    expect(((await edited.json()) as { data: unknown }).data).toMatchObject({
      text: 'Викат ме Иво.',
      editedByPerson: true,
    });

    // Another player cannot touch it.
    const other = await sign('Друг');
    expect(
      (
        await call(
          forgetPoint as Handler,
          'DELETE',
          `/api/v1/me/assistant-memory/${id}`,
          other,
          undefined,
          { id },
        )
      ).status,
    ).toBe(404);

    expect(
      (
        await call(
          forgetPoint as Handler,
          'DELETE',
          `/api/v1/me/assistant-memory/${id}`,
          me,
          undefined,
          { id },
        )
      ).status,
    ).toBe(204);
    expect(await list()).toEqual([]);

    // Said again in a new conversation, a forgotten point is not learned again.
    model.mockResolvedValueOnce(say('Ок.'));
    await stream(me, { message: 'Викат ме Иво.' });
    // Both quiet conversations are read; the model offers the forgotten point again for each.
    model
      .mockResolvedValueOnce(
        extraction([{ text: 'Викат го Иво.', sourceQuote: 'Викат ме Иво', supersedesId: null }]),
      )
      .mockResolvedValueOnce(
        extraction([{ text: 'Викат го Иво.', sourceQuote: 'Викат ме Иво', supersedesId: null }]),
      );
    expect(
      (await call(cron as unknown as Handler, 'POST', '/api/cron/assistant-memory', null)).status,
    ).toBe(401);
    // The cron route, run as the sweep runs it, once the conversation is quiet.
    await asAppSuperuser(db, (tx) =>
      tx.assistantConversation.updateMany({
        where: { userId: me.userId, extractedAt: null },
        data: { lastTurnAt: new Date(Date.now() - 11 * 60_000) },
      }),
    );
    const swept = await call(
      cron as unknown as Handler,
      'POST',
      '/api/cron/assistant-memory',
      null,
      undefined,
      {},
      {
        'x-cron-secret': 'cron-for-tests',
      },
    );
    expect(await swept.json()).toEqual({ read: 2, learned: 0, skipped: 0 });
    expect(await list()).toEqual([]);

    const all = await call(forgetAll as Handler, 'DELETE', '/api/v1/me/assistant-memory', me);
    expect(((await all.json()) as { data: { forgotten: number } }).data).toEqual({ forgotten: 0 });
    expect(first.events[0]!.type).toBe('conversation');
  });

  it('conversations: list, read, delete; a deleted id starts a new conversation; nobody else’s', async () => {
    model.mockResolvedValueOnce(say('Ето.'));
    const { events } = await stream(me, { message: 'Тенис в неделя?' });
    const id = events[0]!.conversationId as string;

    const list = (await (
      await call(listConversations as Handler, 'GET', '/api/v1/me/assistant-conversations', me)
    ).json()) as {
      data: { items: Array<{ id: string; opening: string; turns: number }> };
    };
    expect(list.data.items).toEqual([
      expect.objectContaining({ id, opening: 'Тенис в неделя?', turns: 2 }),
    ]);

    const detail = (await (
      await call(
        getConversation as Handler,
        'GET',
        `/api/v1/me/assistant-conversations/${id}`,
        me,
        undefined,
        { id },
      )
    ).json()) as {
      data: { items: Array<{ role: string; text: string }>; truncated: boolean };
    };
    expect(detail.data.items.map((i) => [i.role, i.text])).toEqual([
      ['user', 'Тенис в неделя?'],
      ['assistant', 'Ето.'],
    ]);

    const other = await sign('Друг');
    expect(
      (
        await call(
          getConversation as Handler,
          'GET',
          `/api/v1/me/assistant-conversations/${id}`,
          other,
          undefined,
          { id },
        )
      ).status,
    ).toBe(404);

    expect(
      (
        await call(
          deleteConversation as Handler,
          'DELETE',
          `/api/v1/me/assistant-conversations/${id}`,
          me,
          undefined,
          { id },
        )
      ).status,
    ).toBe(204);
    expect(
      (
        await call(
          getConversation as Handler,
          'GET',
          `/api/v1/me/assistant-conversations/${id}`,
          me,
          undefined,
          { id },
        )
      ).status,
    ).toBe(404);

    model.mockResolvedValueOnce(say('Ново.'));
    const fresh = await stream(me, { message: 'Пак аз', conversationId: id });
    expect(fresh.events[0]!.conversationId).not.toBe(id);
  });

  it('deleting the account deletes every assistant row', async () => {
    const leaving = await sign('Тръгвам');
    model.mockResolvedValueOnce(say('Ок.'));
    await stream(leaving, { message: 'Казвам се Петя.' });
    await asAppSuperuser(db, (tx) =>
      tx.assistantMemoryFact.create({
        data: {
          userId: leaving.userId,
          text: 'Петя',
          sourceQuote: 'Казвам се Петя',
          sourceAt: new Date(),
        },
      }),
    );
    await deleteMyAccount(leaving.userId);
    const left = await asAppSuperuser(db, (tx) =>
      Promise.all([
        tx.assistantConversation.count({ where: { userId: leaving.userId } }),
        tx.assistantTurn.count({ where: { userId: leaving.userId } }),
        tx.assistantMemoryFact.count({ where: { userId: leaving.userId } }),
        tx.assistantSpend.count({ where: { userId: leaving.userId } }),
      ]),
    );
    expect(left).toEqual([0, 0, 0, 0]);
  });
});
