import { NextRequest } from 'next/server';

import { POST as cancelRoute } from '@/app/api/v1/t/[slug]/bookings/[id]/cancel/route';
import { GET as timesGet } from '@/app/api/v1/coaches/[slug]/lesson-times/route';
import { POST as lessonPost } from '@/app/api/v1/coaches/[slug]/lessons/route';
import { GET as gameGet, PUT as gamePut } from '@/app/api/v1/me/bookings/[id]/game/route';
import { POST as inviteAcceptPost } from '@/app/api/v1/booking-invites/accept/route';
import { POST as invitePreviewPost } from '@/app/api/v1/booking-invites/preview/route';
import { POST as inviteLinkPost } from '@/app/api/v1/me/bookings/[id]/invite-links/route';
import { DELETE as removePlayer } from '@/app/api/v1/me/bookings/[id]/participants/[participantId]/route';
import { POST as addPartner } from '@/app/api/v1/me/bookings/[id]/participants/route';
import { DELETE as leaveBooking } from '@/app/api/v1/me/bookings/[id]/participation/route';
import { GET as myBookingGet } from '@/app/api/v1/me/bookings/[id]/route';
import { GET as myBookingsGet } from '@/app/api/v1/me/bookings/route';
import { GET as myLessonsGet } from '@/app/api/v1/me/coach-lessons/route';
import { POST as lessonCancelPost } from '@/app/api/v1/me/coach-lessons/[id]/cancel/route';
import { POST as lessonNoShowPost } from '@/app/api/v1/me/coach-lessons/[id]/no-show/route';
import { loadDiaryDay } from '@/app/(app)/t/[slug]/admin/calendar/diary-day';
import { clearAllRateLimits } from '@/lib/security/rate-limit';

import { signInAs, type TestIdentity } from '../helpers/auth';
import {
  prismaTestClient,
  resetDatabase,
  seedAccount,
  seedTenant,
  seedVenue,
  type SeededTenant,
} from '../helpers/db';
import { confirmPhoneFor } from '../helpers/phone';
import { asAppSuperuser } from '../helpers/rls';

/**
 * BOOKING A LESSON (#548), through the real routes against a real database.
 *
 * A lesson is a court booking with a coach on it. What these pin down:
 *
 *   - a time is offered only when the coach AND a court are free for all of it,
 *     and the coach's lessons at OTHER clubs count;
 *   - the court and the coach are taken together or not at all, and the one
 *     who loses a race is told which of the two went;
 *   - every rule of a court booking still holds: a confirmed phone, an account
 *     that plays, the cap on upcoming online bookings, the no-show block;
 *   - what is charged: the court's own price on the booking, the coach's fee
 *     on the lesson.
 *
 * 2036-07-14 is a Monday; Sofia is UTC+3 in July. The coach teaches Mondays
 * 09:00–12:00 there (06:00Z–09:00Z); the courts are open 08:00–20:00, booked
 * by the hour for up to three, starting on the hour or the half hour.
 */

// The phone rule (#500) is a switch that is off in the test environment. On
// here, as in production, so that a lesson is shown to be held to it.
jest.mock('@/lib/sms/phone-verifier', () => ({
  ...jest.requireActual('@/lib/sms/phone-verifier'),
  phoneRequired: () => true,
}));

const db = prismaTestClient();
const DAY = '2036-07-14';
const at = (hhmm: string) => `${DAY}T${hhmm}:00+03:00`;
/** The same instant as the API writes it: RFC 3339 in UTC, no milliseconds. */
const utc = (hhmm: string) => new Date(at(hhmm)).toISOString().replace('.000Z', 'Z');

type Json = { data?: unknown; error?: { code: string; message?: string; details?: unknown } };
type Route = (req: NextRequest, ctx: never) => Promise<Response>;

async function call(
  route: unknown,
  url: string,
  init: { method?: string; bearer?: string; json?: unknown; key?: string } = {},
  params?: Record<string, string>,
): Promise<{ status: number; json: Json }> {
  const headers: Record<string, string> = {};
  if (init.bearer) headers.authorization = `Bearer ${init.bearer}`;
  if (init.json !== undefined) headers['content-type'] = 'application/json';
  if (init.key) headers['idempotency-key'] = init.key;
  const req = new NextRequest(`http://t${url}`, {
    method: init.method ?? 'GET',
    headers,
    body: init.json === undefined ? undefined : JSON.stringify(init.json),
  });
  const res = await (route as Route)(req, { params: Promise.resolve(params ?? {}) } as never);
  // A delete that worked answers 204 with no body.
  return { status: res.status, json: res.status === 204 ? {} : ((await res.json()) as Json) };
}

interface TimesDto {
  cancelCutoffHours: number;
  linkId: string;
  venue: { id: string; name: string; timezone: string };
  date: string;
  minutes: number;
  currency: string;
  coachFeeCents: number;
  groupFeeCents: number | null;
  times: Array<{
    startTs: string;
    endTs: string;
    sport: string;
    court: { id: string; name: string };
    courtPriceCents: number;
    totalCents: number;
  }>;
}
interface LessonBookingDto {
  id: string;
  cancellableUntil: string | null;
  status: string;
  startTs: string;
  endTs: string;
  totalCents: number;
  resource: { id: string; name: string; sport: string };
  venue: { id: string; name: string };
  lesson: {
    id: string;
    coach: { slug: string; name: string | null };
    minutes: number;
    coachFeeCents: number;
    groupFeeCents: number | null;
    courtPriceCents: number;
    totalCents: number;
    currency: string;
  };
}

const times = async (slug: string, query: Record<string, string | number>) => {
  const qs = new URLSearchParams(Object.entries(query).map(([k, v]) => [k, String(v)])).toString();
  const r = await call(timesGet, `/api/v1/coaches/${slug}/lesson-times?${qs}`, {}, { slug });
  return { ...r, data: r.json.data as TimesDto, code: r.json.error?.code };
};
const starts = (d: TimesDto) => d.times.map((t) => t.startTs);

let keySeq = 0;
const book = async (
  who: TestIdentity | null,
  slug: string,
  body: Record<string, unknown>,
  key = `lesson-${++keySeq}-${Math.random().toString(36).slice(2)}`,
) => {
  const r = await call(
    lessonPost,
    `/api/v1/coaches/${slug}/lessons`,
    { method: 'POST', bearer: who?.bearer, json: body, key },
    { slug },
  );
  return { ...r, booking: r.json.data as LessonBookingDto, code: r.json.error?.code, key };
};

let club: SeededTenant;
let other: SeededTenant;
let venue: { venueId: string; resourceId: string };
let venueOther: { venueId: string; resourceId: string };
let admin: string;

/** Open a court on Mondays 08:00–20:00. */
const openCourt = (tenantId: string, resourceId: string) =>
  asAppSuperuser(db, (tx) =>
    tx.resourceAvailability.create({
      data: {
        tenantId,
        resourceId,
        dayOfWeek: 1,
        openTime: new Date('1970-01-01T08:00:00Z'),
        closeTime: new Date('1970-01-01T20:00:00Z'),
      },
    }),
  );

/** A second court at a venue, open the same hours. */
async function court(
  at_: { tenantId: string; venueId: string },
  over: { name: string; sport?: string; basePriceCents?: number },
): Promise<string> {
  const r = await asAppSuperuser(db, (tx) =>
    tx.resource.create({
      data: {
        tenantId: at_.tenantId,
        venueId: at_.venueId,
        name: over.name,
        sport: (over.sport ?? 'PADEL') as never,
        surface: 'HARD',
        basePriceCents: over.basePriceCents ?? 2400,
      },
      select: { id: true },
    }),
  );
  await openCourt(at_.tenantId, r.id);
  return r.id;
}

/** An approved coach; teaches padel unless told otherwise. */
async function coach(slug: string, name: string, sports: string[] = ['PADEL']): Promise<string> {
  const userId = await seedAccount('COACH', db);
  await asAppSuperuser(db, async (tx) => {
    await tx.user.update({ where: { id: userId }, data: { name } });
    await tx.$executeRawUnsafe(`SELECT set_config('app.platform_admin_id', $1, true)`, admin);
    await tx.coachProfile.create({
      data: {
        userId,
        slug,
        bio: `Представяне на ${name}.`,
        status: 'APPROVED',
        decidedAt: new Date(),
        decidedByUserId: admin,
        sports: {
          create: sports.map((sport) => ({ sport: sport as never, levelMin: 1, levelMax: 5 })),
        },
      },
    });
  });
  return userId;
}

/** The coach's link at a venue: 40 an hour, lessons of 60 and 120, Mondays 09:00–12:00. */
async function teaches(
  userId: string,
  at_: { tenantId: string; venueId: string },
  over: { groupRateCents?: number | null; hours?: boolean; cancelCutoffHours?: number } = {},
): Promise<string> {
  return asAppSuperuser(db, async (tx) => {
    const link = await tx.coach.create({
      data: {
        tenantId: at_.tenantId,
        venueId: at_.venueId,
        userId,
        status: 'ACTIVE',
        startedBy: 'COACH',
        hourlyRateCents: 4000,
        groupRateCents: over.groupRateCents ?? null,
        lessonMinutes: [60, 120],
        cancelCutoffHours: over.cancelCutoffHours ?? 12,
      },
      select: { id: true },
    });
    if (over.hours !== false) {
      await tx.coachAvailability.create({
        data: {
          tenantId: at_.tenantId,
          coachId: link.id,
          dayOfWeek: 1,
          openTime: new Date('1970-01-01T09:00:00Z'),
          closeTime: new Date('1970-01-01T12:00:00Z'),
        },
      });
    }
    return link.id;
  });
}

/** A player account with a confirmed phone, signed in; a member of no club yet. */
async function player(kind: 'PLAYER' | 'CLUB' | 'COACH' = 'PLAYER', phone = true) {
  const userId = await seedAccount(kind, db);
  if (phone) await confirmPhoneFor(db, userId);
  return signInAs(db, { userId, memberships: [] });
}

const A = () => ({ tenantId: club.tenantId, venueId: venue.venueId });
const B = () => ({ tenantId: other.tenantId, venueId: venueOther.venueId });

const rows = () =>
  asAppSuperuser(db, async (tx) => ({
    bookings: await tx.booking.findMany({ orderBy: { createdAt: 'asc' }, take: 50 }),
    lessons: await tx.coachLesson.findMany({ orderBy: { createdAt: 'asc' }, take: 50 }),
  }));

beforeEach(async () => {
  await resetDatabase(db);
  await clearAllRateLimits();
  club = await seedTenant({ name: 'Клуб Алфа' }, db);
  other = await seedTenant({ name: 'Клуб Бета' }, db);
  venue = await seedVenue(club.tenantId, { name: 'Алфа Кортове' }, db);
  venueOther = await seedVenue(other.tenantId, { name: 'Бета Арена' }, db);
  await openCourt(club.tenantId, venue.resourceId);
  await openCourt(other.tenantId, venueOther.resourceId);
  admin = await seedAccount('PLAYER', db);
});

describe('the times a lesson can start', () => {
  it('where the coach works and a court is free, with both prices; no sign-in needed', async () => {
    const id = await coach('ivan-petrov', 'Иван Петров');
    const linkId = await teaches(id, A(), { groupRateCents: 6000 });

    const { status, data } = await times('ivan-petrov', { linkId, date: DAY, minutes: 60 });
    expect(status).toBe(200);
    expect(data).toMatchObject({
      linkId,
      venue: { id: venue.venueId, name: 'Алфа Кортове', timezone: 'Europe/Sofia' },
      date: DAY,
      minutes: 60,
      currency: 'EUR',
      coachFeeCents: 4000,
      groupFeeCents: 6000,
      // The coach's 12 hours and the club's 24: the stricter.
      cancelCutoffHours: 24,
    });
    // The court opens at eight; the coach starts at nine and stops at twelve.
    expect(starts(data)).toEqual(['09:00', '09:30', '10:00', '10:30', '11:00'].map(utc));
    expect(data.times[0]).toEqual({
      startTs: utc('09:00'),
      endTs: utc('10:00'),
      sport: 'PADEL',
      court: { id: venue.resourceId, name: 'Court 1' },
      courtPriceCents: 2400,
      totalCents: 6400,
    });
    // Nothing of the coach's account.
    expect(JSON.stringify(data)).not.toContain(id);
  });

  it('a two-hour lesson needs both for two hours, and costs two hours of each', async () => {
    const linkId = await teaches(await coach('ivan-petrov', 'Иван Петров'), A());
    const { data } = await times('ivan-petrov', { linkId, date: DAY, minutes: 120 });
    expect(starts(data)).toEqual(['09:00', '09:30', '10:00'].map(utc));
    expect(data.coachFeeCents).toBe(8000);
    expect(data.groupFeeCents).toBeNull();
    expect(data.times[0]).toMatchObject({ courtPriceCents: 4800, totalCents: 12800 });
  });

  it('not while the coach has a lesson at ANOTHER club', async () => {
    const id = await coach('ivan-petrov', 'Иван Петров');
    const linkId = await teaches(id, A());
    const linkB = await teaches(id, B());
    const p = await player();
    expect(
      (await book(p, 'ivan-petrov', { linkId: linkB, startTs: at('10:00'), minutes: 60 })).status,
    ).toBe(201);

    const { data } = await times('ivan-petrov', { linkId, date: DAY, minutes: 60 });
    // Ten to eleven is taken elsewhere; back to back on either side is fine.
    expect(starts(data)).toEqual(['09:00', '11:00'].map(utc));
    // And nothing says where the coach is instead.
    expect(JSON.stringify(data)).not.toContain('Бета');
  });

  it('none on a day off, and the answer does not say it is one', async () => {
    const id = await coach('ivan-petrov', 'Иван Петров');
    const linkId = await teaches(id, A());
    await asAppSuperuser(db, (tx) =>
      tx.coachTimeOff.create({
        data: {
          userId: id,
          startDate: new Date(`${DAY}T00:00:00Z`),
          endDate: new Date(`${DAY}T00:00:00Z`),
          note: 'Почивка',
        },
      }),
    );
    const off = await times('ivan-petrov', { linkId, date: DAY, minutes: 60 });
    expect(off.status).toBe(200);
    expect(off.data.times).toEqual([]);
    expect(JSON.stringify(off.data)).not.toContain('Почивка');
    // A day the coach does not work reads exactly the same, field for field.
    const tuesday = await times('ivan-petrov', { linkId, date: '2036-07-15', minutes: 60 });
    expect({ ...tuesday.data, date: DAY }).toEqual(off.data);
    expect(tuesday.data.times).toEqual([]);
  });

  it('where a court is taken the other one is offered; the cheaper when both are free', async () => {
    const linkId = await teaches(await coach('ivan-petrov', 'Иван Петров'), A());
    const dear = await court(A(), { name: 'Court 2', basePriceCents: 3000 });
    // Court 1 (24) is booked at ten by somebody playing.
    await asAppSuperuser(db, (tx) =>
      tx.booking.create({
        data: {
          tenantId: club.tenantId,
          resourceId: venue.resourceId,
          startTs: new Date(at('10:00')),
          endTs: new Date(at('11:00')),
          status: 'CONFIRMED',
          totalCents: 2400,
          idempotencyKey: 'someone-playing',
          guestName: 'Гост',
          guestPhone: '+359888000000',
        },
      }),
    );
    const { data } = await times('ivan-petrov', { linkId, date: DAY, minutes: 60 });
    const by = Object.fromEntries(data.times.map((t) => [t.startTs, t]));
    expect(by[utc('09:00')]!.court.id).toBe(venue.resourceId);
    expect(by[utc('09:00')]!.totalCents).toBe(6400);
    expect(by[utc('10:00')]!.court.id).toBe(dear);
    expect(by[utc('10:00')]!).toMatchObject({ courtPriceCents: 3000, totalCents: 7000 });
    expect(starts(data)).toEqual(['09:00', '09:30', '10:00', '10:30', '11:00'].map(utc));
  });

  it('only on courts of a sport the coach teaches; `sport` narrows further', async () => {
    const linkId = await teaches(
      await coach('ivan-petrov', 'Иван Петров', ['TENNIS', 'PADEL']),
      A(),
    );
    const tennis = await court(A(), { name: 'Тенис корт', sport: 'TENNIS', basePriceCents: 2000 });
    await court(A(), { name: 'Скуош', sport: 'SQUASH', basePriceCents: 100 });

    const any = await times('ivan-petrov', { linkId, date: DAY, minutes: 60 });
    // The cheapest court of a sport the coach teaches; never the squash court.
    expect(new Set(any.data.times.map((t) => t.court.id))).toEqual(new Set([tennis]));
    const padel = await times('ivan-petrov', { linkId, date: DAY, minutes: 60, sport: 'PADEL' });
    expect(new Set(padel.data.times.map((t) => t.court.id))).toEqual(new Set([venue.resourceId]));
    // A sport the coach does not teach has no times; an unknown one is refused.
    const squash = await times('ivan-petrov', { linkId, date: DAY, minutes: 60, sport: 'SQUASH' });
    expect(squash.data.times).toEqual([]);
    expect(
      (await times('ivan-petrov', { linkId, date: DAY, minutes: 60, sport: 'NOT_A_SPORT' })).status,
    ).toBe(400);
  });

  it('refuses what cannot be answered', async () => {
    const id = await coach('ivan-petrov', 'Иван Петров');
    const linkId = await teaches(id, A());
    await coach('maria-ivanova', 'Мария Иванова');
    const noHours = await teaches(await coach('petar-georgiev', 'Петър Георгиев'), A(), {
      hours: false,
    });

    // A length the coach does not teach here, with the ones they do.
    const len = await times('ivan-petrov', { linkId, date: DAY, minutes: 90 });
    expect([len.status, len.code]).toEqual([400, 'LESSON_LENGTH_NOT_OFFERED']);
    expect(len.json.error?.details).toEqual({ offered: [60, 120] });
    // The link under another coach's address is not there.
    const wrong = await times('maria-ivanova', { linkId, date: DAY, minutes: 60 });
    expect([wrong.status, wrong.code]).toEqual([404, 'COACH_NOT_BOOKABLE']);
    // Nor is one a lesson cannot be booked on yet.
    const unready = await times('petar-georgiev', { linkId: noHours, date: DAY, minutes: 60 });
    expect([unready.status, unready.code]).toEqual([404, 'COACH_NOT_BOOKABLE']);
    for (const q of [
      { linkId, date: '14.07.2036', minutes: 60 },
      { linkId, date: DAY, minutes: 7 },
      { linkId: '', date: DAY, minutes: 60 },
    ]) {
      expect((await times('ivan-petrov', q)).status).toBe(400);
    }
    // A day that has passed has no times.
    expect(
      (await times('ivan-petrov', { linkId, date: '2020-01-06', minutes: 60 })).data.times,
    ).toEqual([]);
  });
});

describe('booking a lesson', () => {
  it('takes the court and the coach in one booking, at the court’s price and the coach’s fee', async () => {
    const id = await coach('ivan-petrov', 'Иван Петров');
    const linkId = await teaches(id, A(), { groupRateCents: 6000, cancelCutoffHours: 24 });
    const p = await player();

    const res = await book(p, 'ivan-petrov', {
      linkId,
      startTs: at('10:00'),
      minutes: 60,
      notes: 'Първи урок',
    });
    expect(res.status).toBe(201);
    expect(res.booking).toMatchObject({
      status: 'CONFIRMED',
      startTs: utc('10:00'),
      endTs: utc('11:00'),
      // The court's part only.
      totalCents: 2400,
      resource: { id: venue.resourceId, name: 'Court 1', sport: 'PADEL' },
      venue: { id: venue.venueId, name: 'Алфа Кортове' },
      lesson: {
        id: expect.any(String),
        coach: { slug: 'ivan-petrov', name: 'Иван Петров' },
        minutes: 60,
        coachFeeCents: 4000,
        groupFeeCents: 6000,
        courtPriceCents: 2400,
        totalCents: 6400,
        currency: 'EUR',
      },
    });

    const { bookings, lessons } = await rows();
    expect(bookings).toHaveLength(1);
    expect(bookings[0]).toMatchObject({
      tenantId: club.tenantId,
      resourceId: venue.resourceId,
      status: 'CONFIRMED',
      channel: 'ONLINE',
      totalCents: 2400,
      bookedByUserId: p.userId,
      notes: 'Първи урок',
    });
    expect(lessons).toHaveLength(1);
    expect(lessons[0]).toMatchObject({
      tenantId: club.tenantId,
      bookingId: bookings[0]!.id,
      coachId: linkId,
      coachUserId: id,
      active: true,
      // The coach's terms as they stood.
      hourlyRateCents: 4000,
      groupRateCents: 6000,
      cancelCutoffHours: 24,
      coachFeeCents: 4000,
    });
    expect(lessons[0]!.startTs).toEqual(new Date(at('10:00')));
    expect(lessons[0]!.endTs).toEqual(new Date(at('11:00')));

    // Booking is how a player joins a club, for a lesson as for a court.
    const membership = await asAppSuperuser(db, (tx) =>
      tx.tenantMembership.findUnique({
        where: { userId_tenantId: { userId: p.userId, tenantId: club.tenantId } },
      }),
    );
    expect(membership).toMatchObject({ role: 'PLAYER', status: 'ACTIVE' });
    // And it is on the club's record.
    const audit = await asAppSuperuser(db, (tx) =>
      tx.auditEntry.findFirst({ where: { action: 'COACH_LESSON_BOOKED' } }),
    );
    expect(audit).toMatchObject({
      tenantId: club.tenantId,
      actorUserId: p.userId,
      entity: 'CoachLesson',
      entityId: lessons[0]!.id,
    });

    // The time is no longer offered, to anybody.
    const { data } = await times('ivan-petrov', { linkId, date: DAY, minutes: 60 });
    expect(starts(data)).toEqual(['09:00', '11:00'].map(utc));
  });

  it('the same key again returns the same lesson and books nothing more', async () => {
    const linkId = await teaches(await coach('ivan-petrov', 'Иван Петров'), A());
    const p = await player();
    const body = { linkId, startTs: at('10:00'), minutes: 60 };
    const first = await book(p, 'ivan-petrov', body);
    const again = await book(p, 'ivan-petrov', body, first.key);
    expect([first.status, again.status]).toEqual([201, 200]);
    expect(again.booking).toEqual(first.booking);
    const { bookings, lessons } = await rows();
    expect([bookings.length, lessons.length]).toEqual([1, 1]);
    // Another player with that key is not handed the first player's lesson.
    const q = await player();
    const theirs = await book(q, 'ivan-petrov', body, first.key);
    expect(theirs.status).toBe(409);
    expect(JSON.stringify(theirs.json)).not.toContain(first.booking.id);
  });

  it('a two-hour lesson: two hours of the court, two of the coach', async () => {
    const linkId = await teaches(await coach('ivan-petrov', 'Иван Петров'), A());
    const res = await book(await player(), 'ivan-petrov', {
      linkId,
      startTs: at('09:30'),
      minutes: 120,
    });
    expect(res.status).toBe(201);
    expect(res.booking).toMatchObject({
      startTs: utc('09:30'),
      endTs: utc('11:30'),
      totalCents: 4800,
      lesson: { minutes: 120, coachFeeCents: 8000, courtPriceCents: 4800, totalCents: 12800 },
    });
  });

  it('a coach is also a player: they can book a lesson with another coach, not with themself', async () => {
    const id = await coach('ivan-petrov', 'Иван Петров');
    const linkId = await teaches(id, A());
    await confirmPhoneFor(db, id);
    const ivan = await signInAs(db, { userId: id, memberships: [] });
    const own = await book(ivan, 'ivan-petrov', { linkId, startTs: at('10:00'), minutes: 60 });
    expect([own.status, own.code]).toEqual([400, 'OWN_LESSON']);

    const otherCoach = await player('COACH');
    const res = await book(otherCoach, 'ivan-petrov', {
      linkId,
      startTs: at('10:00'),
      minutes: 60,
    });
    expect(res.status).toBe(201);
    expect((await rows()).lessons).toHaveLength(1);
  });
});

describe('when the time has gone, the player is told which went', () => {
  it('the coach: booked by somebody else for that time, though another court is free', async () => {
    const linkId = await teaches(await coach('ivan-petrov', 'Иван Петров'), A());
    await court(A(), { name: 'Court 2' });
    const body = { linkId, startTs: at('10:00'), minutes: 60 };
    expect((await book(await player(), 'ivan-petrov', body)).status).toBe(201);

    const late = await book(await player(), 'ivan-petrov', body);
    expect([late.status, late.code]).toEqual([409, 'COACH_TAKEN']);
    // Half an hour later overlaps the same lesson.
    const overlap = await book(await player(), 'ivan-petrov', { ...body, startTs: at('10:30') });
    expect([overlap.status, overlap.code]).toEqual([409, 'COACH_TAKEN']);
    // Nothing of theirs is left holding a court.
    const { bookings, lessons } = await rows();
    expect([bookings.length, lessons.length]).toEqual([1, 1]);
  });

  it('the coach: teaching at another club then', async () => {
    const id = await coach('ivan-petrov', 'Иван Петров');
    const linkId = await teaches(id, A());
    const linkB = await teaches(id, B());
    expect(
      (
        await book(await player(), 'ivan-petrov', {
          linkId: linkB,
          startTs: at('10:00'),
          minutes: 60,
        })
      ).status,
    ).toBe(201);

    const res = await book(await player(), 'ivan-petrov', {
      linkId,
      startTs: at('10:00'),
      minutes: 60,
    });
    expect([res.status, res.code]).toEqual([409, 'COACH_TAKEN']);
    expect((await rows()).bookings.map((b) => b.tenantId)).toEqual([other.tenantId]);
  });

  it('the court: the coach is free and no court is', async () => {
    const linkId = await teaches(await coach('ivan-petrov', 'Иван Петров'), A());
    await asAppSuperuser(db, (tx) =>
      tx.booking.create({
        data: {
          tenantId: club.tenantId,
          resourceId: venue.resourceId,
          startTs: new Date(at('10:00')),
          endTs: new Date(at('11:00')),
          status: 'CONFIRMED',
          totalCents: 2400,
          idempotencyKey: 'someone-playing',
          guestName: 'Гост',
          guestPhone: '+359888000000',
        },
      }),
    );
    const res = await book(await player(), 'ivan-petrov', {
      linkId,
      startTs: at('10:00'),
      minutes: 60,
    });
    expect([res.status, res.code]).toEqual([409, 'SLOT_TAKEN']);
    expect((await rows()).lessons).toEqual([]);
  });

  it('the price: the court the player was shown has gone and the one left costs more; nothing is booked until they agree', async () => {
    const linkId = await teaches(await coach('ivan-petrov', 'Иван Петров'), A());
    const dear = await court(A(), { name: 'Court 2', basePriceCents: 3000 });
    const shown = (await times('ivan-petrov', { linkId, date: DAY, minutes: 60 })).data.times.find(
      (t) => t.startTs === utc('10:00'),
    )!;
    expect(shown).toMatchObject({ court: { id: venue.resourceId }, totalCents: 6400 });

    // Somebody books the cheaper court for that hour, to play.
    await asAppSuperuser(db, (tx) =>
      tx.booking.create({
        data: {
          tenantId: club.tenantId,
          resourceId: venue.resourceId,
          startTs: new Date(at('10:00')),
          endTs: new Date(at('11:00')),
          status: 'CONFIRMED',
          totalCents: 2400,
          idempotencyKey: 'someone-playing',
          guestName: 'Гост',
          guestPhone: '+359888000000',
        },
      }),
    );

    const p = await player();
    const body = { linkId, startTs: at('10:00'), minutes: 60 };
    const refused = await book(p, 'ivan-petrov', { ...body, expectedTotalCents: shown.totalCents });
    expect([refused.status, refused.code]).toEqual([409, 'LESSON_PRICE_CHANGED']);
    expect(refused.json.error?.details).toEqual({ totalCents: 7000 });
    expect((await rows()).lessons).toEqual([]);

    // Shown the new price and agreeing to it, the lesson is booked on the court that is left.
    const agreed = await book(p, 'ivan-petrov', { ...body, expectedTotalCents: 7000 });
    expect(agreed.status).toBe(201);
    expect(agreed.booking).toMatchObject({
      totalCents: 3000,
      resource: { id: dear },
      lesson: { coachFeeCents: 4000, totalCents: 7000 },
    });
  });

  it('a price that went DOWN is simply booked at the lower price', async () => {
    const linkId = await teaches(await coach('ivan-petrov', 'Иван Петров'), A());
    const res = await book(await player(), 'ivan-petrov', {
      linkId,
      startTs: at('10:00'),
      minutes: 60,
      expectedTotalCents: 9900,
    });
    expect(res.status).toBe(201);
    expect(res.booking.lesson.totalCents).toBe(6400);
  });

  it('neither: a time the coach does not teach, or one already past', async () => {
    const linkId = await teaches(await coach('ivan-petrov', 'Иван Петров'), A());
    const p = await player();
    for (const startTs of [
      at('08:00'),
      at('11:30'),
      at('14:00'),
      '2036-07-15T10:00:00+03:00',
      '2020-01-06T10:00:00+02:00',
    ]) {
      const res = await book(p, 'ivan-petrov', { linkId, startTs, minutes: 60 });
      expect([startTs, res.status, res.code]).toEqual([startTs, 409, 'LESSON_TIME_NOT_OFFERED']);
    }
    const { bookings, lessons } = await rows();
    expect([bookings.length, lessons.length]).toEqual([0, 0]);
  });

  it('TWO PLAYERS AT ONCE for one time: one lesson, and the other hears the coach was taken', async () => {
    const linkId = await teaches(await coach('ivan-petrov', 'Иван Петров'), A());
    await court(A(), { name: 'Court 2' });
    const players = await Promise.all([player(), player(), player(), player()]);
    const body = { linkId, startTs: at('10:00'), minutes: 60 };

    const results = await Promise.all(players.map((p) => book(p, 'ivan-petrov', body)));

    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    const lost = results.filter((r) => r.status !== 201);
    expect(lost.map((r) => [r.status, r.code])).toEqual(lost.map(() => [409, 'COACH_TAKEN']));
    const { bookings, lessons } = await rows();
    // One court held, one lesson: no loser is left holding the second court.
    expect([bookings.length, lessons.length]).toEqual([1, 1]);
    expect(lessons[0]!.bookingId).toBe(bookings[0]!.id);
  });

  it('TWO COACHES’ PLAYERS AT ONCE for the one court: one lesson; with a second court, both', async () => {
    const one = await teaches(await coach('ivan-petrov', 'Иван Петров'), A());
    const two = await teaches(await coach('maria-ivanova', 'Мария Иванова'), A());
    const [p, q] = await Promise.all([player(), player()]);

    const tight = await Promise.all([
      book(p, 'ivan-petrov', { linkId: one, startTs: at('09:00'), minutes: 60 }),
      book(q, 'maria-ivanova', { linkId: two, startTs: at('09:00'), minutes: 60 }),
    ]);
    expect(tight.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(tight.find((r) => r.status === 409)!.code).toBe('SLOT_TAKEN');

    // With a second court both lessons fit: the one who loses the first court
    // is moved to the other, not turned away.
    const second = await court(A(), { name: 'Court 2' });
    const roomy = await Promise.all([
      book(p, 'ivan-petrov', { linkId: one, startTs: at('11:00'), minutes: 60 }),
      book(q, 'maria-ivanova', { linkId: two, startTs: at('11:00'), minutes: 60 }),
    ]);
    expect(roomy.map((r) => r.status)).toEqual([201, 201]);
    expect(new Set(roomy.map((r) => r.booking.resource.id))).toEqual(
      new Set([venue.resourceId, second]),
    );
  });
});

describe('every rule of a court booking still holds', () => {
  let linkId: string;
  const body = () => ({ linkId, startTs: at('10:00'), minutes: 60 });
  beforeEach(async () => {
    linkId = await teaches(await coach('ivan-petrov', 'Иван Петров'), A());
  });

  it('signed out, or without the key', async () => {
    const anon = await book(null, 'ivan-petrov', body());
    expect(anon.status).toBe(401);
    const p = await player();
    const noKey = await call(
      lessonPost,
      '/api/v1/coaches/ivan-petrov/lessons',
      { method: 'POST', bearer: p.bearer, json: body() },
      { slug: 'ivan-petrov' },
    );
    expect(noKey.status).toBe(400);
    expect(noKey.json.error?.details).toMatchObject({ field: 'Idempotency-Key' });
  });

  it('a confirmed phone first', async () => {
    const res = await book(await player('PLAYER', false), 'ivan-petrov', body());
    expect([res.status, res.code]).toEqual([403, 'PHONE_REQUIRED']);
  });

  it('a club account does not book', async () => {
    const res = await book(await player('CLUB'), 'ivan-petrov', body());
    expect([res.status, res.code]).toEqual([403, 'PLAYER_ACCOUNT_REQUIRED']);
  });

  it('the club’s cap on upcoming online bookings counts a lesson and holds one back', async () => {
    await asAppSuperuser(db, (tx) =>
      tx.venueOrg.update({ where: { id: club.tenantId }, data: { maxUpcomingOnlineBookings: 1 } }),
    );
    const p = await player();
    expect((await book(p, 'ivan-petrov', body())).status).toBe(201);
    const over = await book(p, 'ivan-petrov', { ...body(), startTs: at('11:00') });
    expect([over.status, over.code]).toEqual([409, 'BOOKING_LIMIT_REACHED']);
    expect(over.json.error?.details).toEqual({ limit: 1, upcoming: 1 });
    const { bookings, lessons } = await rows();
    expect([bookings.length, lessons.length]).toEqual([1, 1]);
  });

  it('three no-shows at the club block a lesson there as they block a court', async () => {
    const p = await player();
    await asAppSuperuser(db, async (tx) => {
      for (const [i, daysAgo] of [3, 10, 80].entries()) {
        const startTs = new Date(Date.now() - daysAgo * 86_400_000 - i * 3_600_000);
        await tx.booking.create({
          data: {
            tenantId: club.tenantId,
            resourceId: venue.resourceId,
            startTs,
            endTs: new Date(startTs.getTime() + 3_600_000),
            status: 'NO_SHOW',
            totalCents: 2400,
            idempotencyKey: `no-show-${i}`,
            bookedByUserId: p.userId,
          },
        });
      }
    });
    const res = await book(p, 'ivan-petrov', body());
    expect([res.status, res.code]).toEqual([403, 'NO_SHOW_BLOCKED']);
    expect((await rows()).lessons).toEqual([]);
  });

  it('what cannot be booked at all', async () => {
    const p = await player();
    await coach('maria-ivanova', 'Мария Иванова');
    const wrong = await book(p, 'maria-ivanova', body());
    expect([wrong.status, wrong.code]).toEqual([404, 'COACH_NOT_BOOKABLE']);
    const len = await book(p, 'ivan-petrov', { ...body(), minutes: 90 });
    expect([len.status, len.code]).toEqual([400, 'LESSON_LENGTH_NOT_OFFERED']);
    for (const bad of [
      { ...body(), minutes: '60' },
      { ...body(), startTs: 'tomorrow' },
      { startTs: at('10:00'), minutes: 60 },
    ]) {
      expect((await book(p, 'ivan-petrov', bad)).status).toBe(400);
    }
    // A link that has ended is not bookable, whatever was shown a minute ago.
    await asAppSuperuser(db, (tx) =>
      tx.coach.update({ where: { id: linkId }, data: { status: 'ENDED', endedAt: new Date() } }),
    );
    const ended = await book(p, 'ivan-petrov', body());
    expect([ended.status, ended.code]).toEqual([404, 'COACH_NOT_BOOKABLE']);
    expect((await rows()).bookings).toEqual([]);
  });

  it('a body cannot set a price or pick a court', async () => {
    const dear = await court(A(), { name: 'Court 2', basePriceCents: 9000 });
    const res = await book(await player(), 'ivan-petrov', {
      ...body(),
      totalCents: 1,
      coachFeeCents: 1,
      resourceId: dear,
    });
    expect(res.status).toBe(201);
    expect(res.booking).toMatchObject({
      totalCents: 2400,
      resource: { id: venue.resourceId },
      lesson: { coachFeeCents: 4000, totalCents: 6400 },
    });
  });
});

describe('until when a lesson can be cancelled: the stricter of the coach’s cutoff and the club’s', () => {
  const HOUR = 3_600_000;
  const cancel = (who: TestIdentity, bookingId: string) =>
    call(
      cancelRoute,
      `/api/v1/t/${club.tenantSlug}/bookings/${bookingId}/cancel`,
      { method: 'POST', bearer: who.bearer, json: {} },
      { slug: club.tenantSlug, id: bookingId },
    );

  it('the booking says the earlier deadline, and so do the times before it is booked', async () => {
    // The club's cutoff is the default 24 hours; this coach asks for 48.
    const linkId = await teaches(await coach('ivan-petrov', 'Иван Петров'), A(), {
      cancelCutoffHours: 48,
    });
    expect(
      (await times('ivan-petrov', { linkId, date: DAY, minutes: 60 })).data.cancelCutoffHours,
    ).toBe(48);
    const res = await book(await player(), 'ivan-petrov', {
      linkId,
      startTs: at('10:00'),
      minutes: 60,
    });
    expect(res.booking.cancellableUntil).toBe(
      new Date(new Date(at('10:00')).getTime() - 48 * HOUR).toISOString().replace('.000Z', 'Z'),
    );

    // A coach who asks for less than the club does not loosen the club's rule.
    const lax = await teaches(await coach('maria-ivanova', 'Мария Иванова'), A(), {
      cancelCutoffHours: 2,
    });
    expect(
      (await times('maria-ivanova', { linkId: lax, date: DAY, minutes: 60 })).data
        .cancelCutoffHours,
    ).toBe(24);
    const other = await book(await player(), 'maria-ivanova', {
      linkId: lax,
      startTs: at('11:00'),
      minutes: 60,
    });
    expect(other.booking.cancellableUntil).toBe(
      new Date(new Date(at('11:00')).getTime() - 24 * HOUR).toISOString().replace('.000Z', 'Z'),
    );
  });

  /** A lesson `hoursAhead` from now, written as booking one writes it. */
  async function lessonIn(hoursAhead: number, coachCutoff: number, who: TestIdentity) {
    const id = await coach(`coach-${coachCutoff}`, 'Иван Петров');
    const linkId = await teaches(id, A(), { cancelCutoffHours: coachCutoff });
    const startTs = new Date(Math.ceil(Date.now() / HOUR) * HOUR + hoursAhead * HOUR);
    const endTs = new Date(startTs.getTime() + HOUR);
    return asAppSuperuser(db, async (tx) => {
      await tx.tenantMembership.create({
        data: { tenantId: club.tenantId, userId: who.userId, role: 'PLAYER', status: 'ACTIVE' },
      });
      const booking = await tx.booking.create({
        data: {
          tenantId: club.tenantId,
          resourceId: venue.resourceId,
          startTs,
          endTs,
          status: 'CONFIRMED',
          totalCents: 2400,
          idempotencyKey: `soon-${coachCutoff}`,
          bookedByUserId: who.userId,
        },
      });
      await tx.coachLesson.create({
        data: {
          tenantId: club.tenantId,
          bookingId: booking.id,
          coachId: linkId,
          coachUserId: id,
          startTs,
          endTs,
          hourlyRateCents: 4000,
          cancelCutoffHours: coachCutoff,
          coachFeeCents: 4000,
        },
      });
      return booking.id;
    });
  }

  it('30 hours ahead: past the coach’s 48, so the player cannot cancel though the club’s 24 would allow it', async () => {
    const p = await player();
    const bookingId = await lessonIn(30, 48, p);
    const res = await cancel(p, bookingId);
    expect([res.status, res.json.error?.code]).toEqual([403, 'CANCELLATION_CUTOFF_PASSED']);
    expect((await rows()).lessons[0]).toMatchObject({ active: true });
  });

  it('30 hours ahead with a coach who asks for 12: the club’s 24 decides, and it is not past', async () => {
    const p = await player();
    const bookingId = await lessonIn(30, 12, p);
    expect((await cancel(p, bookingId)).status).toBe(200);
    expect((await rows()).lessons[0]).toMatchObject({ active: false });
  });
});

describe('a cancelled lesson', () => {
  it('frees the court and the coach: the time is offered again and can be booked', async () => {
    const linkId = await teaches(await coach('ivan-petrov', 'Иван Петров'), A());
    const p = await player();
    const body = { linkId, startTs: at('10:00'), minutes: 60 };
    const first = await book(p, 'ivan-petrov', body);
    expect(first.status).toBe(201);

    const cancelled = await call(
      cancelRoute,
      `/api/v1/t/${club.tenantSlug}/bookings/${first.booking.id}/cancel`,
      { method: 'POST', bearer: p.bearer, json: {} },
      { slug: club.tenantSlug, id: first.booking.id },
    );
    expect(cancelled.status).toBe(200);
    expect((await rows()).lessons[0]).toMatchObject({ active: false });

    const { data } = await times('ivan-petrov', { linkId, date: DAY, minutes: 60 });
    expect(starts(data)).toContain(utc('10:00'));
    expect((await book(await player(), 'ivan-petrov', body)).status).toBe(201);
  });
});

describe('where a booked lesson is seen', () => {
  const LABELS = { unknownPlayer: 'Играч', guest: 'Гост', deletedUser: 'Изтрит потребител' };

  it('in the player’s Резервации: who teaches it, both prices, and the stricter deadline', async () => {
    const id = await coach('ivan-petrov', 'Иван Петров');
    const linkId = await teaches(id, A(), { groupRateCents: 6000, cancelCutoffHours: 48 });
    const p = await player();
    await asAppSuperuser(db, (tx) =>
      tx.user.update({ where: { id: p.userId }, data: { name: 'Петя Играч' } }),
    );
    const booked = await book(p, 'ivan-petrov', { linkId, startTs: at('10:00'), minutes: 60 });

    const list = await call(myBookingsGet, '/api/v1/me/bookings?when=upcoming', {
      bearer: p.bearer,
    });
    const items = (list.json.data as { items: Array<Record<string, unknown>> }).items;
    expect(items).toHaveLength(1);
    const lesson = {
      id: booked.booking.lesson.id,
      coach: { slug: 'ivan-petrov', name: 'Иван Петров' },
      coachFeeCents: 4000,
      groupFeeCents: 6000,
      courtPriceCents: 2400,
      totalCents: 6400,
    };
    expect(items[0]).toMatchObject({
      id: booked.booking.id,
      // The court's part; the whole is on the lesson.
      totalCents: 2400,
      lesson,
      cancellableUntil: new Date(new Date(at('10:00')).getTime() - 48 * 3_600_000)
        .toISOString()
        .replace('.000Z', 'Z'),
    });

    const one = await call(
      myBookingGet,
      `/api/v1/me/bookings/${booked.booking.id}`,
      { bearer: p.bearer },
      { id: booked.booking.id },
    );
    expect(one.status).toBe(200);
    expect(one.json.data).toMatchObject({ id: booked.booking.id, lesson });

    // A plain court booking carries `lesson: null`, not a missing field.
    await asAppSuperuser(db, (tx) =>
      tx.booking.create({
        data: {
          tenantId: club.tenantId,
          resourceId: venue.resourceId,
          startTs: new Date(at('15:00')),
          endTs: new Date(at('16:00')),
          status: 'CONFIRMED',
          totalCents: 2400,
          idempotencyKey: 'just-a-court',
          bookedByUserId: p.userId,
        },
      }),
    );
    const both = await call(myBookingsGet, '/api/v1/me/bookings?when=upcoming', {
      bearer: p.bearer,
    });
    expect(
      (both.json.data as { items: Array<{ lesson: unknown }> }).items.map((b) => b.lesson !== null),
    ).toEqual([true, false]);
  });

  it('a coach the platform has since removed: the lesson still names them and links nowhere', async () => {
    const id = await coach('ivan-petrov', 'Иван Петров');
    const linkId = await teaches(id, A());
    const p = await player();
    await book(p, 'ivan-petrov', { linkId, startTs: at('10:00'), minutes: 60 });
    await asAppSuperuser(db, async (tx) => {
      await tx.$executeRawUnsafe(`SELECT set_config('app.platform_admin_id', $1, true)`, admin);
      await tx.coachProfile.update({
        where: { userId: id },
        data: { status: 'DECLINED', decidedAt: new Date(), decidedByUserId: admin },
      });
    });
    const list = await call(myBookingsGet, '/api/v1/me/bookings', { bearer: p.bearer });
    expect(
      (list.json.data as { items: Array<{ lesson: { coach: unknown } }> }).items[0]!.lesson.coach,
    ).toEqual({ slug: null, name: 'Иван Петров' });
  });

  it('in the club’s diary: the coach’s name on the block, and the whole amount to collect', async () => {
    const id = await coach('ivan-petrov', 'Иван Петров');
    const linkId = await teaches(id, A());
    const p = await player();
    const booked = await book(p, 'ivan-petrov', { linkId, startTs: at('10:00'), minutes: 60 });

    const day = await loadDiaryDay(club.tenantId, DAY, { locale: 'bg', labels: LABELS });
    const block = day.bookings.find((b) => b.id === booked.booking.id)!;
    expect(block).toMatchObject({
      startLabel: '10:00',
      endLabel: '11:00',
      status: 'CONFIRMED',
      lessonCoach: 'Иван Петров',
      // Still ahead: the desk can cancel it from the diary (#549).
      lessonCancellable: true,
    });
    // 24 for the court and 40 for the coach.
    expect(block.priceLabel).toMatch(/^64,00\s€$/);
    // The other club's diary has nothing of it.
    const elsewhere = await loadDiaryDay(other.tenantId, DAY, { locale: 'bg', labels: LABELS });
    expect(elsewhere.bookings).toEqual([]);
  });

  it('the club’s desk cancels a lesson: the court and the coach are free, and the player is told the club cancelled', async () => {
    const id = await coach('ivan-petrov', 'Иван Петров');
    const linkId = await teaches(id, A());
    const p = await player();
    const booked = await book(p, 'ivan-petrov', { linkId, startTs: at('10:00'), minutes: 60 });
    const owner = await signInAs(db, {
      userId: club.userId,
      memberships: [{ tenantId: club.tenantId, tenantSlug: club.tenantSlug, role: 'OWNER' }],
    });
    await asAppSuperuser(db, (tx) => tx.notification.deleteMany({ where: { userId: p.userId } }));

    const res = await call(
      cancelRoute,
      `/api/v1/t/${club.tenantSlug}/bookings/${booked.booking.id}/cancel`,
      { method: 'POST', bearer: owner.bearer, json: {} },
      { slug: club.tenantSlug, id: booked.booking.id },
    );
    expect(res.status).toBe(200);
    const { bookings, lessons } = await rows();
    expect(bookings[0]).toMatchObject({ status: 'CANCELLED' });
    expect(lessons[0]).toMatchObject({ active: false });
    const bell = await asAppSuperuser(db, (tx) =>
      tx.notification.findMany({ where: { userId: p.userId }, take: 5 }),
    );
    expect(bell.map((n) => n.title)).toEqual(['Клубът отмени резервацията ви']);
    // It is gone from the diary, and the time can be booked again.
    const day = await loadDiaryDay(club.tenantId, DAY, { locale: 'bg', labels: LABELS });
    expect(day.bookings).toEqual([]);
    const { data } = await times('ivan-petrov', { linkId, date: DAY, minutes: 60 });
    expect(starts(data)).toContain(utc('10:00'));
  });

  describe('in the coach’s own «Уроци»', () => {
    const mine = async (who: TestIdentity, when?: string) => {
      const r = await call(myLessonsGet, `/api/v1/me/coach-lessons${when ? `?when=${when}` : ''}`, {
        bearer: who.bearer,
      });
      return {
        ...r,
        items:
          (
            r.json.data as
              { items: Array<Record<string, unknown>>; nextCursor: string | null } | undefined
          )?.items ?? [],
      };
    };

    it('their lessons at every club, soonest first, with who booked and their own fee', async () => {
      const id = await coach('ivan-petrov', 'Иван Петров');
      const linkA = await teaches(id, A());
      const linkB = await teaches(id, B());
      const ivan = await signInAs(db, { userId: id, memberships: [] });
      const p = await player();
      await asAppSuperuser(db, (tx) =>
        tx.user.update({ where: { id: p.userId }, data: { name: 'Петя Играч' } }),
      );
      const later = await book(p, 'ivan-petrov', {
        linkId: linkA,
        startTs: at('11:00'),
        minutes: 60,
      });
      const sooner = await book(await player(), 'ivan-petrov', {
        linkId: linkB,
        startTs: at('09:00'),
        minutes: 60,
      });
      // Another coach's lesson is nobody else's business.
      const mariaId = await coach('maria-ivanova', 'Мария Иванова');
      await book(await player(), 'maria-ivanova', {
        linkId: await teaches(mariaId, A()),
        startTs: at('09:00'),
        minutes: 60,
      });

      const res = await mine(ivan);
      expect(res.status).toBe(200);
      expect(res.items.map((l) => l.bookingId)).toEqual([sooner.booking.id, later.booking.id]);
      expect(res.items[1]).toEqual({
        id: later.booking.lesson.id,
        bookingId: later.booking.id,
        status: 'CONFIRMED',
        startTs: utc('11:00'),
        endTs: utc('12:00'),
        venue: { id: venue.venueId, name: 'Алфа Кортове', timezone: 'Europe/Sofia' },
        club: 'Клуб Алфа',
        court: { name: 'Court 1', sport: 'PADEL' },
        // What a coach is shown of a player (decision 12): the name, the
        // level (none said here) and, the lesson being ahead, the phone.
        player: { name: 'Петя Играч', level: null, phone: expect.stringMatching(/^\+3598\d+$/) },
        players: 1,
        coachFeeCents: 4000,
        currency: 'EUR',
      });
      // And nothing more of them: no address, no account id.
      const text = JSON.stringify(res.items);
      expect(text).not.toContain(p.userId);
      expect(text).not.toMatch(/@playerz\.test|email/i);
      // And the court's price is the club's: not in the coach's list.
      expect(text).not.toContain('2400');
    });

    it('a cancelled lesson moves from upcoming to past', async () => {
      const id = await coach('ivan-petrov', 'Иван Петров');
      const linkId = await teaches(id, A());
      const ivan = await signInAs(db, { userId: id, memberships: [] });
      const p = await player();
      const booked = await book(p, 'ivan-petrov', { linkId, startTs: at('10:00'), minutes: 60 });
      expect((await mine(ivan, 'upcoming')).items).toHaveLength(1);
      expect((await mine(ivan, 'past')).items).toEqual([]);

      await call(
        cancelRoute,
        `/api/v1/t/${club.tenantSlug}/bookings/${booked.booking.id}/cancel`,
        { method: 'POST', bearer: p.bearer, json: {} },
        { slug: club.tenantSlug, id: booked.booking.id },
      );
      expect((await mine(ivan, 'upcoming')).items).toEqual([]);
      expect((await mine(ivan, 'past')).items).toMatchObject([
        { bookingId: booked.booking.id, status: 'CANCELLED' },
      ]);
    });

    it('pages by a cursor', async () => {
      const id = await coach('ivan-petrov', 'Иван Петров');
      const linkId = await teaches(id, A());
      const ivan = await signInAs(db, { userId: id, memberships: [] });
      for (const t of ['09:00', '10:00', '11:00']) {
        await book(await player(), 'ivan-petrov', { linkId, startTs: at(t), minutes: 60 });
      }
      const first = await call(myLessonsGet, '/api/v1/me/coach-lessons?limit=2', {
        bearer: ivan.bearer,
      });
      const page1 = first.json.data as { items: Array<{ startTs: string }>; nextCursor: string };
      expect(page1.items.map((l) => l.startTs)).toEqual([utc('09:00'), utc('10:00')]);
      const second = await call(
        myLessonsGet,
        `/api/v1/me/coach-lessons?limit=2&cursor=${page1.nextCursor}`,
        { bearer: ivan.bearer },
      );
      expect(second.json.data).toMatchObject({
        items: [{ startTs: utc('11:00') }],
        nextCursor: null,
      });
    });

    it('is a coach’s: a player is refused, signed out is 401, and a bad `when` is 400', async () => {
      const p = await player();
      const refused = await mine(p);
      expect([refused.status, refused.json.error?.code]).toEqual([403, 'COACH_ACCOUNT_REQUIRED']);
      expect((await call(myLessonsGet, '/api/v1/me/coach-lessons')).status).toBe(401);
      const ivan = await signInAs(db, {
        userId: await coach('ivan-petrov', 'Иван Петров'),
        memberships: [],
      });
      expect((await mine(ivan, 'soon')).status).toBe(400);
      expect((await mine(ivan)).items).toEqual([]);
    });
  });
});

describe('more than one player on a lesson: the coach’s fee follows them (#549; decisions 9, 18, 19, 20)', () => {
  const fees = async () => (await rows()).lessons.map((l) => l.coachFeeCents);
  const feeAudits = () =>
    asAppSuperuser(db, (tx) =>
      tx.auditEntry.findMany({
        where: { action: 'COACH_LESSON_FEE_CHANGED' },
        orderBy: { createdAt: 'asc' },
        select: { detailsJson: true, actorUserId: true },
        take: 20,
      }),
    );
  /** The booker makes a link; `who` opens it and joins. */
  async function joinByLink(booker: TestIdentity, bookingId: string, who: TestIdentity) {
    const link = await call(
      inviteLinkPost,
      `/api/v1/me/bookings/${bookingId}/invite-links`,
      { method: 'POST', bearer: booker.bearer, json: {} },
      { id: bookingId },
    );
    expect(link.status).toBe(201);
    const token = (link.json.data as { token: string }).token;
    const joined = await call(invitePreviewPost, '/api/v1/booking-invites/preview', {
      method: 'POST',
      json: { token },
    });
    const accepted = await call(inviteAcceptPost, '/api/v1/booking-invites/accept', {
      method: 'POST',
      bearer: who.bearer,
      json: { token },
    });
    expect(accepted.status).toBe(200);
    return { token, preview: joined.json.data as Record<string, unknown> };
  }
  const detail = async (who: TestIdentity, bookingId: string) =>
    (
      await call(
        myBookingGet,
        `/api/v1/me/bookings/${bookingId}`,
        { bearer: who.bearer },
        { id: bookingId },
      )
    ).json.data as {
      playersOpen: boolean;
      players: Array<{ participantId: string | null; isBooker: boolean }>;
      lesson: { coachFeeCents: number; groupFeeCents: number | null; totalCents: number };
    };

  it('the second player makes it a group lesson at the group fee, for the whole group; a third changes nothing; back to one, back to the one-player fee', async () => {
    const linkId = await teaches(await coach('ivan-petrov', 'Иван Петров'), A(), {
      groupRateCents: 6000,
    });
    // A court for four, so there is room for a group.
    await asAppSuperuser(db, (tx) =>
      tx.resource.update({ where: { id: venue.resourceId }, data: { capacity: 4 } }),
    );
    const booker = await player();
    const booked = await book(booker, 'ivan-petrov', { linkId, startTs: at('10:00'), minutes: 60 });
    const id = booked.booking.id;

    // Before anybody is added the page is told what a group would cost.
    expect(await detail(booker, id)).toMatchObject({
      playersOpen: true,
      lesson: { coachFeeCents: 4000, groupFeeCents: 6000, totalCents: 6400 },
    });

    const second = await player();
    const { preview } = await joinByLink(booker, id, second);
    // The invited person is told it is a lesson, and with whom, before joining.
    expect(preview).toMatchObject({ lesson: { coach: 'Иван Петров' } });
    expect(await fees()).toEqual([6000]);
    expect(await detail(booker, id)).toMatchObject({
      lesson: { coachFeeCents: 6000, totalCents: 8400 },
    });
    // The added player sees the same lesson and the same price.
    expect(await detail(second, id)).toMatchObject({ lesson: { coachFeeCents: 6000 } });

    // One fee for the whole group: a third player does not raise it.
    const third = await player();
    await joinByLink(booker, id, third);
    expect(await fees()).toEqual([6000]);

    // The third leaves: still a group of two.
    expect(
      (
        await call(
          leaveBooking,
          `/api/v1/me/bookings/${id}/participation`,
          { method: 'DELETE', bearer: third.bearer },
          { id },
        )
      ).status,
    ).toBe(204);
    expect(await fees()).toEqual([6000]);

    // The booker removes the second: one player, the one-player fee again.
    const added = (await detail(booker, id)).players.find((p) => !p.isBooker)!;
    expect(
      (
        await call(
          removePlayer,
          `/api/v1/me/bookings/${id}/participants/${added.participantId}`,
          { method: 'DELETE', bearer: booker.bearer },
          { id, participantId: added.participantId! },
        )
      ).status,
    ).toBe(204);
    expect(await fees()).toEqual([4000]);

    // Each change of the fee is on the club's record, and only the changes.
    const audits = await feeAudits();
    expect(
      audits.map((a) => {
        const d = a.detailsJson as {
          players: number;
          before: { coachFeeCents: number };
          after: { coachFeeCents: number };
        };
        return [d.players, d.before.coachFeeCents, d.after.coachFeeCents, a.actorUserId];
      }),
    ).toEqual([
      [2, 4000, 6000, second.userId],
      [1, 6000, 4000, booker.userId],
    ]);
  });

  it('the one added player leaves: the lesson is one player’s again, at the one-player fee', async () => {
    const linkId = await teaches(await coach('ivan-petrov', 'Иван Петров'), A(), {
      groupRateCents: 6000,
    });
    const booker = await player();
    const booked = await book(booker, 'ivan-petrov', { linkId, startTs: at('10:00'), minutes: 60 });
    const id = booked.booking.id;
    const second = await player();
    await joinByLink(booker, id, second);
    expect(await fees()).toEqual([6000]);
    expect(
      (
        await call(
          leaveBooking,
          `/api/v1/me/bookings/${id}/participation`,
          { method: 'DELETE', bearer: second.bearer },
          { id },
        )
      ).status,
    ).toBe(204);
    expect(await fees()).toEqual([4000]);
    expect((await feeAudits()).map((a) => a.actorUserId)).toEqual([second.userId, second.userId]);
  });

  it('a past partner added by the booker counts the same as one who came by link', async () => {
    const linkId = await teaches(await coach('ivan-petrov', 'Иван Петров'), A(), {
      groupRateCents: 6000,
    });
    const booker = await player();
    const partner = await player();
    // They have played together before: that is what makes the partner addable.
    await asAppSuperuser(db, async (tx) => {
      const past = await tx.booking.create({
        data: {
          tenantId: club.tenantId,
          resourceId: venue.resourceId,
          startTs: new Date('2026-07-01T07:00:00Z'),
          endTs: new Date('2026-07-01T08:00:00Z'),
          status: 'COMPLETED',
          totalCents: 2400,
          idempotencyKey: 'played-together',
          bookedByUserId: booker.userId,
        },
      });
      await tx.tenantMembership.createMany({
        data: [booker.userId, partner.userId].map((userId) => ({
          tenantId: club.tenantId,
          userId,
          role: 'PLAYER' as const,
          status: 'ACTIVE' as const,
        })),
        skipDuplicates: true,
      });
      await tx.bookingParticipant.create({
        data: { tenantId: club.tenantId, bookingId: past.id, userId: partner.userId, position: 2 },
      });
    });
    const booked = await book(booker, 'ivan-petrov', { linkId, startTs: at('10:00'), minutes: 60 });
    const id = booked.booking.id;
    const added = await call(
      addPartner,
      `/api/v1/me/bookings/${id}/participants`,
      { method: 'POST', bearer: booker.bearer, json: { userId: partner.userId } },
      { id },
    );
    expect(added.status).toBe(201);
    expect(await fees()).toEqual([6000]);
  });

  it('the group rate is per hour too: a two-hour group lesson is two hours of it', async () => {
    const linkId = await teaches(await coach('ivan-petrov', 'Иван Петров'), A(), {
      groupRateCents: 6000,
    });
    const booker = await player();
    const booked = await book(booker, 'ivan-petrov', {
      linkId,
      startTs: at('09:00'),
      minutes: 120,
    });
    expect(await fees()).toEqual([8000]);
    await joinByLink(booker, booked.booking.id, await player());
    expect(await fees()).toEqual([12000]);
  });

  it('a coach with no group rate: players can be added, and the fee stays the one-player fee', async () => {
    const linkId = await teaches(await coach('ivan-petrov', 'Иван Петров'), A());
    const booker = await player();
    const booked = await book(booker, 'ivan-petrov', { linkId, startTs: at('10:00'), minutes: 60 });
    const id = booked.booking.id;
    expect(await detail(booker, id)).toMatchObject({
      playersOpen: true,
      lesson: { coachFeeCents: 4000, groupFeeCents: null },
    });
    await joinByLink(booker, id, await player());
    expect(await fees()).toEqual([4000]);
    expect((await detail(booker, id)).players).toHaveLength(2);
    expect(await feeAudits()).toEqual([]);
  });

  it('the group fee is what the club’s diary collects and what the coach’s list shows', async () => {
    const coachId = await coach('ivan-petrov', 'Иван Петров');
    const linkId = await teaches(coachId, A(), { groupRateCents: 6000 });
    const booker = await player();
    const booked = await book(booker, 'ivan-petrov', { linkId, startTs: at('10:00'), minutes: 60 });
    await joinByLink(booker, booked.booking.id, await player());

    const day = await loadDiaryDay(club.tenantId, DAY, {
      locale: 'bg',
      labels: { unknownPlayer: 'Играч', guest: 'Гост', deletedUser: 'Изтрит потребител' },
    });
    // 24 for the court and 60 for the group.
    expect(day.bookings[0]!.priceLabel).toMatch(/^84,00\s€$/);
    const ivan = await signInAs(db, { userId: coachId, memberships: [] });
    const mine = await call(myLessonsGet, '/api/v1/me/coach-lessons', { bearer: ivan.bearer });
    expect((mine.json.data as { items: Array<{ coachFeeCents: number }> }).items).toMatchObject([
      { coachFeeCents: 6000 },
    ]);
  });

  it('a lesson is for the people its booker invites: it is never opened in «Игри»', async () => {
    const linkId = await teaches(await coach('ivan-petrov', 'Иван Петров'), A(), {
      groupRateCents: 6000,
    });
    const p = await player();
    const booked = await book(p, 'ivan-petrov', { linkId, startTs: at('10:00'), minutes: 60 });
    const id = booked.booking.id;
    const view = await call(
      gameGet,
      `/api/v1/me/bookings/${id}/game`,
      { bearer: p.bearer },
      { id },
    );
    expect(view.json.data).toMatchObject({ canOpen: false, game: null });
    const open = await call(
      gamePut,
      `/api/v1/me/bookings/${id}/game`,
      { method: 'PUT', bearer: p.bearer, json: { spots: 1 } },
      { id },
    );
    expect([open.status, open.json.error?.code]).toEqual([409, 'GAME_NOT_OPENABLE']);
    expect(await asAppSuperuser(db, (tx) => tx.openGame.count())).toBe(0);
  });
});

describe('the coach and their lessons (#549; decisions 8, 11, 12)', () => {
  const HOUR = 3_600_000;
  type Item = {
    id: string;
    bookingId: string;
    status: string;
    players: number;
    player: { name: string | null; level: number | null; phone: string | null } | null;
  };
  const mine = async (who: TestIdentity, when: 'upcoming' | 'past' = 'upcoming') =>
    (
      (await call(myLessonsGet, `/api/v1/me/coach-lessons?when=${when}`, { bearer: who.bearer }))
        .json.data as { items: Item[] }
    ).items;
  const cancelIt = (who: TestIdentity | null, id: string, json: unknown = {}) =>
    call(
      lessonCancelPost,
      `/api/v1/me/coach-lessons/${id}/cancel`,
      { method: 'POST', bearer: who?.bearer, json },
      { id },
    );
  const noShow = (who: TestIdentity | null, id: string) =>
    call(
      lessonNoShowPost,
      `/api/v1/me/coach-lessons/${id}/no-show`,
      { method: 'POST', bearer: who?.bearer },
      { id },
    );

  /** Ivan, approved, teaching at venue A, signed in. */
  async function ivan(over: Parameters<typeof teaches>[2] = {}) {
    const id = await coach('ivan-petrov', 'Иван Петров');
    const linkId = await teaches(id, A(), over);
    return { id, linkId, who: await signInAs(db, { userId: id, memberships: [] }) };
  }

  /** One of Ivan's lessons `hoursFromNow` away (negative: it has started), as booking writes it. */
  async function lessonAt(
    c: { id: string; linkId: string },
    p: TestIdentity,
    hoursFromNow: number,
  ) {
    const startTs = new Date(Math.floor(Date.now() / HOUR) * HOUR + hoursFromNow * HOUR);
    const endTs = new Date(startTs.getTime() + HOUR);
    return asAppSuperuser(db, async (tx) => {
      await tx.tenantMembership.createMany({
        data: [{ tenantId: club.tenantId, userId: p.userId, role: 'PLAYER', status: 'ACTIVE' }],
        skipDuplicates: true,
      });
      const booking = await tx.booking.create({
        data: {
          tenantId: club.tenantId,
          resourceId: venue.resourceId,
          startTs,
          endTs,
          status: 'CONFIRMED',
          totalCents: 2400,
          idempotencyKey: `at-${hoursFromNow}-${Math.random()}`,
          bookedByUserId: p.userId,
        },
      });
      const lesson = await tx.coachLesson.create({
        data: {
          tenantId: club.tenantId,
          bookingId: booking.id,
          coachId: c.linkId,
          coachUserId: c.id,
          startTs,
          endTs,
          hourlyRateCents: 4000,
          cancelCutoffHours: 12,
          coachFeeCents: 4000,
        },
      });
      return { bookingId: booking.id, lessonId: lesson.id };
    });
  }

  describe('what the coach is shown of the player', () => {
    it('the name, the level they declared in this sport, and the confirmed phone, for a lesson still to come', async () => {
      const c = await ivan();
      const p = await player();
      const number = await confirmPhoneFor(db, p.userId, '+359888123456');
      await asAppSuperuser(db, async (tx) => {
        await tx.user.update({ where: { id: p.userId }, data: { name: 'Петя Играч' } });
        await tx.playerSportLevel.createMany({
          data: [
            // The lesson is on a padel court; the tennis level is not this lesson's.
            { userId: p.userId, sport: 'PADEL', level: 4 },
            { userId: p.userId, sport: 'TENNIS', level: 6 },
          ],
        });
      });
      await book(p, 'ivan-petrov', { linkId: c.linkId, startTs: at('10:00'), minutes: 60 });

      expect(await mine(c.who)).toMatchObject([
        { players: 1, player: { name: 'Петя Играч', level: 4, phone: number } },
      ]);
    });

    it('no level said, no phone confirmed: null, not a guess', async () => {
      const c = await ivan();
      // The phone rule is on in this file, so the lesson is written directly.
      const p = await signInAs(db, { userId: await seedAccount('PLAYER', db), memberships: [] });
      await lessonAt(c, p, 48);
      expect((await mine(c.who))[0]!.player).toEqual({
        name: expect.any(String),
        level: null,
        phone: null,
      });
    });

    it('the phone is for upcoming lessons only: gone once the lesson is over or cancelled', async () => {
      const c = await ivan();
      const p = await player();
      const number = await confirmPhoneFor(db, p.userId, '+359888123456');
      const upcoming = await lessonAt(c, p, 48);
      const over = await lessonAt(c, p, -30);

      const soon = await mine(c.who);
      expect(soon.map((l) => [l.id, l.player?.phone])).toEqual([[upcoming.lessonId, number]]);
      const past = await mine(c.who, 'past');
      expect(past.map((l) => [l.id, l.player?.phone])).toEqual([[over.lessonId, null]]);

      // Cancelled by the player: on the past list now, and no number with it.
      await asAppSuperuser(db, (tx) =>
        tx.booking.update({
          where: { id: upcoming.bookingId },
          data: { status: 'CANCELLED', cancelledAt: new Date() },
        }),
      );
      expect(await mine(c.who)).toEqual([]);
      const after = await mine(c.who, 'past');
      expect(after.every((l) => l.player?.phone === null)).toBe(true);
      expect(JSON.stringify(after)).not.toContain(number);
    });

    it('a group says how many are on it', async () => {
      const c = await ivan({ groupRateCents: 6000 });
      const p = await player();
      const made = await lessonAt(c, p, 48);
      await asAppSuperuser(db, (tx) =>
        tx.bookingParticipant.create({
          data: {
            tenantId: club.tenantId,
            bookingId: made.bookingId,
            guestName: 'Гост',
            position: 2,
          },
        }),
      );
      expect((await mine(c.who))[0]).toMatchObject({ players: 2 });
    });
  });

  describe('the coach cancels a lesson', () => {
    it('until it starts: the booking is cancelled, the court and the coach are free again, and the player is told by bell and email', async () => {
      const c = await ivan();
      const p = await player();
      const booked = await book(p, 'ivan-petrov', {
        linkId: c.linkId,
        startTs: at('10:00'),
        minutes: 60,
      });
      const lessonId = booked.booking.lesson.id;
      await asAppSuperuser(db, async (tx) => {
        await tx.notification.deleteMany({});
        await tx.emailOutbox.deleteMany({});
      });

      const res = await cancelIt(c.who, lessonId, { reason: 'Болен съм' });
      expect(res.status).toBe(200);
      expect(res.json.data).toEqual({ bookingId: booked.booking.id });

      const { bookings, lessons } = await rows();
      expect(bookings[0]).toMatchObject({ status: 'CANCELLED' });
      expect(lessons[0]).toMatchObject({ active: false });
      // On the club's record as the coach's act, with the reason given.
      const [cancellation, audit] = await asAppSuperuser(db, async (tx) => [
        await tx.cancellation.findFirst({ where: { bookingId: booked.booking.id } }),
        await tx.auditEntry.findFirst({
          where: { action: 'BOOKING_CANCELLED', entityId: booked.booking.id },
        }),
      ]);
      expect(cancellation).toMatchObject({ cancelledByUserId: c.id, reason: 'Болен съм' });
      expect(audit).toMatchObject({ actorUserId: c.id, details: 'Cancelled by the coach' });

      // The player hears, in the bell and by email, that it was the coach.
      const [bell, mail] = await asAppSuperuser(db, async (tx) => [
        await tx.notification.findMany({ where: { userId: p.userId }, take: 5 }),
        await tx.emailOutbox.findMany({ where: { userId: p.userId }, take: 5 }),
      ]);
      expect(bell).toHaveLength(1);
      expect(bell[0]).toMatchObject({
        kind: 'BOOKING_CANCELLED',
        title: 'Треньорът отмени урока ви',
      });
      expect(bell[0]!.body).toContain('Кортът е освободен');
      expect(mail).toHaveLength(1);
      expect(mail[0]!.subject).toContain('Треньорът отмени урока ви');
      expect(mail[0]!.text).toContain('не дължите нищо');
      // The coach is not told about their own act.
      expect(
        await asAppSuperuser(db, (tx) => tx.notification.count({ where: { userId: c.id } })),
      ).toBe(0);

      // The time is on offer again.
      const { data } = await times('ivan-petrov', { linkId: c.linkId, date: DAY, minutes: 60 });
      expect(starts(data)).toContain(utc('10:00'));
      // And it is on the coach's past list, as cancelled.
      expect(await mine(c.who)).toEqual([]);
      expect(await mine(c.who, 'past')).toMatchObject([{ id: lessonId, status: 'CANCELLED' }]);
    });

    it('with no cutoff of their own: an hour before the start is still in time', async () => {
      const c = await ivan({ cancelCutoffHours: 48 });
      const made = await lessonAt(c, await player(), 1);
      expect((await cancelIt(c.who, made.lessonId)).status).toBe(200);
    });

    it('not once it has started', async () => {
      const c = await ivan();
      const made = await lessonAt(c, await player(), 0);
      const res = await cancelIt(c.who, made.lessonId);
      expect([res.status, res.json.error?.code]).toEqual([409, 'LESSON_STARTED']);
      expect((await rows()).bookings[0]).toMatchObject({ status: 'CONFIRMED' });
    });

    it('twice is a refusal, not a second cancellation', async () => {
      const c = await ivan();
      const made = await lessonAt(c, await player(), 24);
      expect((await cancelIt(c.who, made.lessonId)).status).toBe(200);
      const again = await cancelIt(c.who, made.lessonId);
      expect([again.status, again.json.error?.code]).toEqual([409, 'BOOKING_NOT_CANCELLABLE']);
      expect(await asAppSuperuser(db, (tx) => tx.cancellation.count())).toBe(1);
    });

    it('only their own: another coach, the player and a stranger get the same 404; signed out is 401', async () => {
      const c = await ivan();
      const p = await player();
      const made = await lessonAt(c, p, 24);
      const maria = await signInAs(db, {
        userId: await coach('maria-ivanova', 'Мария Иванова'),
        memberships: [],
      });
      for (const who of [maria, p, await player()]) {
        const res = await cancelIt(who, made.lessonId);
        expect([res.status, res.json.error?.code]).toEqual([404, 'LESSON_NOT_FOUND']);
        const ns = await noShow(who, made.lessonId);
        expect([ns.status, ns.json.error?.code]).toEqual([404, 'LESSON_NOT_FOUND']);
      }
      expect((await cancelIt(null, made.lessonId)).status).toBe(401);
      expect((await noShow(null, made.lessonId)).status).toBe(401);
      expect((await cancelIt(c.who, 'cnosuchlesson0000000000')).status).toBe(404);
      expect((await rows()).bookings[0]).toMatchObject({ status: 'CONFIRMED' });
    });
  });

  describe('the coach marks a no-show', () => {
    it('once the lesson has started: it is the club’s no-show, and counts there', async () => {
      const c = await ivan();
      const p = await player();
      const made = await lessonAt(c, p, -2);

      const res = await noShow(c.who, made.lessonId);
      expect(res.status).toBe(200);
      const { bookings, lessons } = await rows();
      expect(bookings[0]).toMatchObject({ status: 'NO_SHOW' });
      expect(lessons[0]).toMatchObject({ active: false });
      const [standing, audit] = await asAppSuperuser(db, async (tx) => [
        await tx.playerVenueRelationship.findUnique({
          where: { tenantId_playerUserId: { tenantId: club.tenantId, playerUserId: p.userId } },
        }),
        await tx.auditEntry.findFirst({ where: { action: 'BOOKING_NO_SHOW' } }),
      ]);
      expect(standing).toMatchObject({ noShowCount: 1 });
      expect(audit).toMatchObject({ actorUserId: c.id });
      expect(audit!.detailsJson).toMatchObject({ by: 'COACH' });
      // On the coach's past list as a no-show, with nothing more to do to it.
      expect(await mine(c.who, 'past')).toMatchObject([{ status: 'NO_SHOW' }]);

      const again = await noShow(c.who, made.lessonId);
      expect([again.status, again.json.error?.code, again.json.error?.details]).toEqual([
        409,
        'NO_SHOW_REFUSED',
        { reason: 'ALREADY_NO_SHOW' },
      ]);
    });

    it('three of them block the player’s online booking at that club, as three at the desk would', async () => {
      const c = await ivan();
      const p = await player();
      for (const hours of [-30, -60, -90]) {
        const made = await lessonAt(c, p, hours);
        expect((await noShow(c.who, made.lessonId)).status).toBe(200);
      }
      const res = await book(p, 'ivan-petrov', {
        linkId: c.linkId,
        startTs: at('10:00'),
        minutes: 60,
      });
      expect([res.status, res.code]).toEqual([403, 'NO_SHOW_BLOCKED']);
    });

    it('not before it starts, and not a cancelled lesson', async () => {
      const c = await ivan();
      const p = await player();
      const ahead = await lessonAt(c, p, 24);
      const early = await noShow(c.who, ahead.lessonId);
      expect([early.status, early.json.error?.details]).toEqual([409, { reason: 'NOT_STARTED' }]);

      const gone = await lessonAt(c, p, -3);
      await asAppSuperuser(db, (tx) =>
        tx.booking.update({ where: { id: gone.bookingId }, data: { status: 'CANCELLED' } }),
      );
      const cancelled = await noShow(c.who, gone.lessonId);
      expect([cancelled.status, cancelled.json.error?.details]).toEqual([
        409,
        { reason: 'NOT_ATTENDABLE' },
      ]);
      expect(await asAppSuperuser(db, (tx) => tx.playerVenueRelationship.count())).toBe(0);
    });
  });
});
