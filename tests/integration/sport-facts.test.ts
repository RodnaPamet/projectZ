import path from 'node:path';

import { NextRequest } from 'next/server';

import { POST as cronRoute } from '@/app/api/cron/send-sport-facts/route';
import {
  getMyNotificationSettings,
  updateMyNotificationSettings,
} from '@/app-layer/usecases/my-notifications';
import { sendSportFacts } from '@/app-layer/usecases/sport-facts';
import { sendApns } from '@/lib/push/apns';

import { prismaTestClient, seedAccount, seedTenant, seedVenue } from '../helpers/db';
import { asAppSuperuser } from '../helpers/rls';

/**
 * «Факт на деня» (owner 2026-11-13): once a day from 10:00 Sofia, to each
 * player with a device, today's fact about their main sport, in their
 * language. The APNs sender is a stand-in that records what it was asked to
 * send; the people, their sports, bookings, devices, switches and the bell
 * rows are real. The stories are the test fixture (TENNIS only).
 */
jest.mock('@/lib/push/apns', () => ({
  ...jest.requireActual('@/lib/push/apns'),
  sendApns: jest.fn(async () => ({ ok: true })),
}));
const mockApns = sendApns as jest.Mock;

const db = prismaTestClient();

const previous = process.env.SPORT_STORIES_DIR;
beforeAll(() => {
  process.env.SPORT_STORIES_DIR = path.join(process.cwd(), 'tests/fixtures/sport-stories');
});
afterAll(() => {
  if (previous === undefined) delete process.env.SPORT_STORIES_DIR;
  else process.env.SPORT_STORIES_DIR = previous;
});

/** 11:30 in Sofia on 13 November 2026: day 316, fact 5. */
const MORNING = new Date('2026-11-13T09:30:00Z');

async function player(
  opts: {
    kind?: 'PLAYER' | 'COACH';
    sports?: Array<'TENNIS' | 'PADEL' | 'BADMINTON'>;
    device?: boolean;
    locale?: 'bg' | 'en';
  } = {},
): Promise<string> {
  const userId = await seedAccount(opts.kind ?? 'PLAYER', db);
  await asAppSuperuser(db, async (tx) => {
    if (opts.locale) await tx.user.update({ where: { id: userId }, data: { locale: opts.locale } });
    if (opts.sports?.length) {
      await tx.playerSportLevel.createMany({
        data: opts.sports.map((sport) => ({ userId, sport, level: 3 })),
      });
    }
    if (opts.device ?? true) {
      await tx.deviceToken.create({
        data: {
          userId,
          deviceToken: userId.padEnd(64, '0').slice(0, 64),
          bundleId: 'bg.playerz.app',
          environment: 'SANDBOX',
        },
      });
    }
  });
  return userId;
}

const factRows = (userId: string) =>
  asAppSuperuser(db, (tx) =>
    tx.notification.findMany({
      where: { userId, kind: 'SPORT_FACT' },
      select: { title: true, body: true, href: true, refType: true, refId: true, dedupeKey: true },
    }),
  );

beforeEach(() => mockApns.mockClear());

describe('the daily fact push', () => {
  it('sends today’s fact for the first profile sport, once a day however often it runs', async () => {
    // TENNIS sorts before BADMINTON in the profile's own order, as /me shows it.
    const ana = await player({ sports: ['BADMINTON', 'TENNIS'] });

    expect(await sendSportFacts(MORNING)).toEqual({
      day: '2026-11-13',
      waiting: null,
      sent: 1,
      truncated: false,
    });
    expect(await factRows(ana)).toEqual([
      {
        title: 'Факт на деня · Тенис',
        body: 'Тенис факт номер 5.',
        href: '/venues?sport=TENNIS',
        refType: 'sport',
        refId: 'TENNIS',
        dedupeKey: 'sport-fact:2026-11-13',
      },
    ]);
    expect(mockApns).toHaveBeenCalledTimes(1);
    expect(mockApns.mock.calls[0][1]).toMatchObject({
      title: 'Факт на деня · Тенис',
      body: 'Тенис факт номер 5.',
      threadId: 'sport:TENNIS',
    });

    // The loop asks again every 15 minutes: nothing more that day.
    const later = new Date('2026-11-13T20:00:00Z');
    expect(await sendSportFacts(later)).toMatchObject({ sent: 0, waiting: null });
    expect(mockApns).toHaveBeenCalledTimes(1);

    // The next Sofia day is a new fact.
    expect(await sendSportFacts(new Date('2026-11-14T09:30:00Z'))).toMatchObject({ sent: 1 });
    expect((await factRows(ana)).map((r) => r.body).sort()).toEqual([
      'Тенис факт номер 5.',
      'Тенис факт номер 6.',
    ]);
  });

  it('waits until 10:00 in Sofia', async () => {
    await player({ sports: ['TENNIS'] });
    // 09:59 Sofia (07:59 UTC in winter).
    expect(await sendSportFacts(new Date('2026-11-13T07:59:00Z'))).toEqual({
      day: '2026-11-13',
      waiting: 'before-send-hour',
      sent: 0,
      truncated: false,
    });
    expect(await sendSportFacts(new Date('2026-11-13T08:00:00Z'))).toMatchObject({ sent: 1 });
  });

  it('falls back to the sport booked most, in the player’s language', async () => {
    const ben = await player({ locale: 'en' });
    const club = await seedTenant({}, db);
    const { venueId, resourceId: padel } = await seedVenue(club.tenantId, {}, db);
    await asAppSuperuser(db, async (tx) => {
      const tennis = await tx.resource.create({
        data: {
          tenantId: club.tenantId,
          venueId,
          name: 'Court 2',
          sport: 'TENNIS',
          surface: 'CLAY',
          basePriceCents: 2000,
        },
      });
      const booking = (resourceId: string, day: number, status: 'COMPLETED' | 'CANCELLED') =>
        tx.booking.create({
          data: {
            tenantId: club.tenantId,
            resourceId,
            bookedByUserId: ben,
            startTs: new Date(Date.UTC(2026, 9, day, 16)),
            endTs: new Date(Date.UTC(2026, 9, day, 17)),
            totalCents: 2000,
            status,
            idempotencyKey: `k-${resourceId}-${day}`,
          },
        });
      // Two tennis games played; padel booked three times, but two were cancelled.
      await booking(tennis.id, 1, 'COMPLETED');
      await booking(tennis.id, 2, 'COMPLETED');
      await booking(padel, 1, 'COMPLETED');
      await booking(padel, 2, 'CANCELLED');
      await booking(padel, 3, 'CANCELLED');
    });

    expect(await sendSportFacts(MORNING)).toMatchObject({ sent: 1 });
    expect(await factRows(ben)).toEqual([
      expect.objectContaining({ title: 'Fact of the day · Tennis', body: 'Tennis fact number 5.' }),
    ]);
  });

  it('leaves out who has no main sport, no story for it, no device, the switch off, or is not a player', async () => {
    const noSport = await player();
    const noStory = await player({ sports: ['PADEL'] });
    const noDevice = await player({ sports: ['TENNIS'], device: false });
    const switchedOff = await player({ sports: ['TENNIS'] });
    const coach = await player({ kind: 'COACH', sports: ['TENNIS'] });
    await updateMyNotificationSettings(switchedOff, { push: { sportFacts: false } });

    expect(await sendSportFacts(MORNING)).toMatchObject({ sent: 0, truncated: false });
    for (const id of [noSport, noStory, noDevice, switchedOff, coach]) {
      expect(await factRows(id)).toEqual([]);
    }
    expect(mockApns).not.toHaveBeenCalled();
  });

  it('the switch is on by default and is the phone’s alone', async () => {
    const id = await player({ sports: ['TENNIS'] });
    const settings = await getMyNotificationSettings(id);
    expect(settings!.push.sportFacts).toBe(true);
    expect(settings!.email).not.toHaveProperty('sportFacts');

    const off = await updateMyNotificationSettings(id, { push: { sportFacts: false } });
    expect(off!.push).toMatchObject({ sportFacts: false, confirmation: true });

    const on = await updateMyNotificationSettings(id, { push: { sportFacts: true } });
    expect(on!.push.sportFacts).toBe(true);
    expect(await sendSportFacts(MORNING)).toMatchObject({ sent: 1 });
  });

  describe('POST /api/cron/send-sport-facts', () => {
    const OLD = process.env.CRON_SECRET;
    const SECRET = 'cron-secret-for-tests'; // pragma: allowlist secret
    afterEach(() => {
      process.env.CRON_SECRET = OLD;
    });
    const post = (secret?: string) =>
      cronRoute(
        new NextRequest('http://t/api/cron/send-sport-facts', {
          method: 'POST',
          headers: secret ? { 'x-cron-secret': secret } : {},
        }),
      );

    it('refuses without the secret, and with none configured', async () => {
      process.env.CRON_SECRET = SECRET;
      expect((await post()).status).toBe(401);
      expect((await post('wrong')).status).toBe(401);
      delete process.env.CRON_SECRET;
      expect((await post('anything')).status).toBe(503);
    });

    it('runs with it and answers what the loop reads', async () => {
      process.env.CRON_SECRET = SECRET;
      const res = await post(SECRET);
      expect(res.status).toBe(200);
      // The real clock: before 10:00 Sofia it waits, after it there is nobody to send to.
      const body = await res.json();
      expect(body).toMatchObject({ sent: 0, truncated: false });
      expect(body.day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(['before-send-hour', null]).toContain(body.waiting);
    });
  });
});
