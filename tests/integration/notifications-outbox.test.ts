import { NextRequest } from 'next/server';

import { POST as cronDrainRoute } from '@/app/api/cron/drain-email-outbox/route';
import { POST as cronReminderRoute } from '@/app/api/cron/send-booking-reminders/route';
import {
  GET as settingsGetRoute,
  PATCH as settingsPatchRoute,
} from '@/app/api/v1/me/notification-settings/route';
import { POST as readRoute } from '@/app/api/v1/me/notifications/read/route';
import { GET as listRoute } from '@/app/api/v1/me/notifications/route';
import { POST as seriesCancelRoute } from '@/app/api/v1/t/[slug]/admin/booking-series/[id]/cancel/route';
import { POST as seriesRoute } from '@/app/api/v1/t/[slug]/admin/booking-series/route';
import { POST as deskRoute } from '@/app/api/v1/t/[slug]/admin/desk-bookings/route';
import { POST as cancelRoute } from '@/app/api/v1/t/[slug]/bookings/[id]/cancel/route';
import { POST as bookRoute } from '@/app/api/v1/t/[slug]/bookings/route';
import {
  acceptBookingInvite,
  addCoPlayer,
  createBookingInviteLink,
  leaveBooking,
  removeBookingPlayer,
} from '@/app-layer/usecases/booking-players';
import { sendBookingReminders } from '@/app-layer/usecases/booking-notifications';
import {
  deliver,
  drainEmailOutbox,
  EMAIL_MAX_ATTEMPTS,
} from '@/app-layer/usecases/notification-outbox';
import {
  selectEmailProvider,
  type EmailProvider,
  type OutgoingEmail,
  type SendOutcome,
} from '@/lib/email/provider';
import { dailyDedupeKey } from '@/lib/notifications/dedupe';

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
 * NOTIFICATIONS (#367, Q22): the bell and the email outbox, through the real
 * routes against a real database.
 *
 *   - an outbox row (and a bell row) for each event, and none for an opted-out category;
 *   - the reminder exactly once, in its window, across the 25 October DST change;
 *   - the staging guard, retries with backoff, and the dead letter;
 *   - the bell API: own rows only, IDOR 404, mark-read;
 *   - the recipient's language.
 */

const ZONE = 'Europe/Sofia';
const NO_PARAMS = { params: Promise.resolve({}) };
const HOUR = 3_600_000;

type Json = {
  data?: Record<string, unknown> & { id?: string };
  error?: { code: string; message: string; details?: Record<string, unknown> };
};

/** A provider that records what it was asked to send, and answers as told. */
function recorder(
  answer: (m: OutgoingEmail) => SendOutcome = () => ({ ok: true, messageId: 'm' }),
) {
  const sent: OutgoingEmail[] = [];
  const provider: EmailProvider = {
    name: 'resend',
    send: async (m) => {
      sent.push(m);
      return answer(m);
    },
  };
  return { sent, provider };
}

describe('notifications (#367)', () => {
  const db = prismaTestClient();

  let club: SeededTenant;
  let resourceId: string;
  let staff: TestIdentity;
  let booker: TestIdentity;
  let friend: TestIdentity;

  const slug = () => club.tenantSlug;

  async function person(name: string, locale: 'bg' | 'en' = 'bg') {
    const id = await seedPlayer(db, club.tenantId, name.toLowerCase());
    await asAppSuperuser(db, (tx) =>
      tx.user.update({ where: { id }, data: { name, locale, accountKind: 'PLAYER' } }),
    );
    return signInAs(db, {
      userId: id,
      memberships: [{ tenantId: club.tenantId, tenantSlug: club.tenantSlug, role: 'PLAYER' }],
    });
  }

  beforeEach(async () => {
    await resetDatabase(db);
    club = await seedTenant({}, db);
    resourceId = await asAppSuperuser(db, async (tx) => {
      const venue = await tx.venue.create({
        data: {
          tenantId: club.tenantId,
          slug: `n-${club.tenantId.slice(-8)}`,
          name: 'Sofia Padel',
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
          tenantId: club.tenantId,
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
          tenantId: club.tenantId,
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
        data: { tenantId: club.tenantId, userId: staffId, role: 'STAFF', status: 'ACTIVE' },
      }),
    );
    staff = await signInAs(db, {
      userId: staffId,
      memberships: [{ tenantId: club.tenantId, tenantSlug: club.tenantSlug, role: 'STAFF' }],
    });
    booker = await person('Иван');
    friend = await person('Мария');
  });

  // ─── helpers ────────────────────────────────────────────────────────

  const headers = (who: TestIdentity | null, key?: string) => ({
    ...(who ? { authorization: `Bearer ${who.bearer}` } : {}),
    'content-type': 'application/json',
    ...(key ? { 'idempotency-key': key } : {}),
  });
  const read = async (res: Response) => ({ status: res.status, body: (await res.json()) as Json });

  /** An online booking through the real route, 08:00 UTC on a far-future day. */
  const book = (who: TestIdentity, day = '2036-07-16', key = `k-${Math.random()}`) =>
    bookRoute(
      new NextRequest(`http://t/api/v1/t/${slug()}/bookings`, {
        method: 'POST',
        headers: headers(who, key),
        body: JSON.stringify({
          resourceId,
          startTs: `${day}T08:00:00Z`,
          endTs: `${day}T09:00:00Z`,
        }),
      }),
      { params: Promise.resolve({ slug: slug() }) },
    ).then(read);

  const cancel = (id: string, who: TestIdentity) =>
    cancelRoute(
      new NextRequest(`http://t/api/v1/t/${slug()}/bookings/${id}/cancel`, {
        method: 'POST',
        headers: headers(who),
      }),
      { params: Promise.resolve({ slug: slug(), id }) },
    ).then(read);

  const admin = (
    route: (req: NextRequest, ctx: never) => Promise<Response>,
    path: string,
    body: unknown,
    params = {},
  ) =>
    route(
      new NextRequest(`http://t/api/v1/t/${slug()}/admin/${path}`, {
        method: 'POST',
        headers: headers(staff, `k-${Math.random()}`),
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ slug: slug(), ...params }) } as never,
    ).then(read);

  const bells = (userId: string) =>
    asAppSuperuser(db, (tx) =>
      tx.notification.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } }),
    );
  const outbox = (userId?: string) =>
    asAppSuperuser(db, (tx) =>
      tx.emailOutbox.findMany({
        where: userId ? { userId } : {},
        orderBy: { createdAt: 'asc' },
      }),
    );
  const setUser = (id: string, data: Record<string, unknown>) =>
    asAppSuperuser(db, (tx) => tx.user.update({ where: { id }, data }));

  /** A CONFIRMED booking written directly: the reminder tests pin every instant. */
  const seedBooking = (
    startTs: Date,
    over: { createdAt?: Date; status?: 'CONFIRMED' | 'CANCELLED'; by?: string } = {},
  ) =>
    asAppSuperuser(db, (tx) =>
      tx.booking.create({
        data: {
          tenantId: club.tenantId,
          resourceId,
          startTs,
          endTs: new Date(startTs.getTime() + HOUR),
          status: over.status ?? 'CONFIRMED',
          totalCents: 2400,
          bookedByUserId: over.by ?? booker.userId,
          idempotencyKey: `seed-${Math.random()}`,
          createdAt: over.createdAt ?? new Date('2026-10-01T09:00:00Z'),
        },
        select: { id: true },
      }),
    ).then((b) => b.id);

  const addParticipant = (bookingId: string, userId: string) =>
    asAppSuperuser(db, (tx) =>
      tx.bookingParticipant.create({
        data: { tenantId: club.tenantId, bookingId, userId, position: 2 },
      }),
    );

  // ─── events ─────────────────────────────────────────────────────────

  it('a booking: the booker gets the bell and the confirmation email, once', async () => {
    const made = await book(booker, '2036-07-16', 'same-key');
    expect(made.status).toBe(201);
    const id = made.body.data!.id!;

    const [bell] = await bells(booker.userId);
    expect(bell).toMatchObject({
      kind: 'BOOKING_CONFIRMED',
      title: 'Резервацията е потвърдена',
      href: `/me/bookings/${id}`,
      refType: 'booking',
      refId: id,
      dedupeKey: `booking:${id}:confirmed`,
      readAt: null,
      tenantId: club.tenantId,
    });
    expect(bell!.body).toMatch(/^Sofia Padel, Корт 1 · .*11:00–12:00$/);

    const [mail] = await outbox(booker.userId);
    expect(mail).toMatchObject({
      kind: 'BOOKING_CONFIRMED',
      category: 'confirmation',
      locale: 'bg',
      status: 'PENDING',
      refId: id,
      expiresAt: new Date('2036-07-16T08:00:00Z'),
    });
    expect(mail!.subject).toMatch(/^Резервацията е потвърдена: Sofia Padel, /);
    expect(mail!.text).toContain('Плащане: на място в клуба');
    expect(mail!.text).toContain(`/me/bookings/${id}`);

    // A retry with the same key is a replay: nothing new.
    expect((await book(booker, '2036-07-16', 'same-key')).status).toBe(200);
    expect(await bells(booker.userId)).toHaveLength(1);
    expect(await outbox()).toHaveLength(1);
    // Nobody else hears about it.
    expect(await bells(friend.userId)).toHaveLength(0);
    expect(await bells(staff.userId)).toHaveLength(0);
  });

  it('in the RECIPIENT’s language', async () => {
    await setUser(booker.userId, { locale: 'en' });
    await book(booker);
    expect((await bells(booker.userId))[0]!.title).toBe('Booking confirmed');
    const [mail] = await outbox(booker.userId);
    expect(mail).toMatchObject({ locale: 'en' });
    expect(mail!.subject).toMatch(/^Booking confirmed: Sofia Padel/);
    expect(mail!.text).toContain('Payment: at the club');
  });

  it('an opted-out category gets the bell and no email', async () => {
    await setUser(booker.userId, { emailBookingConfirmations: false });
    await book(booker);
    expect(await bells(booker.userId)).toHaveLength(1);
    expect(await outbox()).toHaveLength(0);
  });

  it('cancelled by the club: booker and added players hear, by email too; the staff member does not', async () => {
    const id = (await book(booker)).body.data!.id!;
    await addParticipant(id, friend.userId);
    expect((await cancel(id, staff)).status).toBe(200);

    for (const who of [booker, friend]) {
      const cancelled = (await bells(who.userId)).find((b) => b.kind === 'BOOKING_CANCELLED');
      expect(cancelled).toMatchObject({ title: 'Клубът отмени резервацията ви' });
      expect((await outbox(who.userId)).find((o) => o.category === 'clubChanges')).toBeTruthy();
    }
    expect(await bells(staff.userId)).toHaveLength(0);
  });

  it('cancelled by the booker: the added players hear in the bell only, the booker not at all', async () => {
    const id = (await book(booker)).body.data!.id!;
    await addParticipant(id, friend.userId);
    expect((await cancel(id, booker)).status).toBe(200);

    expect((await bells(friend.userId)).map((b) => b.title)).toEqual(['Играта е отменена']);
    expect(await outbox(friend.userId)).toHaveLength(0);
    expect((await bells(booker.userId)).map((b) => b.kind)).toEqual(['BOOKING_CONFIRMED']);
  });

  it('a desk booking linked to a player confirms to them; an unlinked one tells nobody', async () => {
    const linked = await admin(deskRoute, 'desk-bookings', {
      resourceId,
      date: '2036-07-16',
      startTime: '10:00',
      durationMinutes: 60,
      customer: { name: 'Иван', phone: '0888 123 456', userId: booker.userId },
    });
    expect(linked.status).toBe(201);
    expect((await bells(booker.userId)).map((b) => b.kind)).toEqual(['BOOKING_CONFIRMED']);
    expect((await outbox(booker.userId))[0]!.text).toContain('10:00–11:00');

    const walkIn = await admin(deskRoute, 'desk-bookings', {
      resourceId,
      date: '2036-07-16',
      startTime: '12:00',
      durationMinutes: 60,
      customer: { name: 'Гост', phone: '0888 000 000' },
    });
    expect(walkIn.status).toBe(201);
    expect(await asAppSuperuser(db, (tx) => tx.notification.count())).toBe(1);
    expect(await outbox()).toHaveLength(1);
  });

  it('a weekly series: one confirmation; cancelling the rest: one notification, by email, counting the weeks', async () => {
    const made = await admin(seriesRoute, 'booking-series', {
      resourceId,
      date: '2036-07-16',
      startTime: '19:00',
      durationMinutes: 60,
      repeat: { weeks: 4 },
      customer: { name: 'Иван', phone: '0888 123 456', userId: booker.userId },
    });
    expect(made.status).toBe(201);
    const seriesId = made.body.data!.id!;
    expect((await bells(booker.userId)).map((b) => [b.kind, b.title])).toEqual([
      ['BOOKING_CONFIRMED', 'Клубът запази седмичен час за вас'],
    ]);

    const cut = await admin(
      seriesCancelRoute,
      `booking-series/${seriesId}/cancel`,
      {
        fromDate: '2036-07-23',
      },
      { id: seriesId },
    );
    expect(cut.status).toBe(200);
    const cancelled = (await bells(booker.userId)).filter((b) => b.kind === 'BOOKING_CANCELLED');
    expect(cancelled).toHaveLength(1);
    expect(cancelled[0]!.title).toBe('Клубът отмени седмичните ви игри');
    const mail = (await outbox(booker.userId)).find((o) => o.category === 'clubChanges')!;
    expect(mail.text).toContain('Отменени игри: 3');

    // Repeating the cancel cancels nothing, and says nothing.
    await admin(
      seriesCancelRoute,
      `booking-series/${seriesId}/cancel`,
      {
        fromDate: '2036-07-23',
      },
      { id: seriesId },
    );
    expect((await bells(booker.userId)).filter((b) => b.kind === 'BOOKING_CANCELLED')).toHaveLength(
      1,
    );
  });

  it('who is playing (#416): joins, leaves, adds and removals reach the bell, never email', async () => {
    const id = await seedBooking(new Date('2036-07-16T08:00:00Z'));
    // An earlier game together, so the booker can add Мария from "played with".
    await addParticipant(await seedBooking(new Date('2036-07-01T08:00:00Z')), friend.userId);
    const link = await createBookingInviteLink({ userId: booker.userId, bookingId: id });

    await acceptBookingInvite({ userId: friend.userId, token: link.token });
    await leaveBooking({ userId: friend.userId, bookingId: id });
    expect((await bells(booker.userId)).map((b) => b.title)).toEqual([
      'Мария се включи в играта',
      'Мария напусна играта',
    ]);

    // Joining again is a new event, not a duplicate of the first.
    await acceptBookingInvite({ userId: friend.userId, token: link.token });
    expect(await bells(booker.userId)).toHaveLength(3);

    const participant = await asAppSuperuser(db, (tx) =>
      tx.bookingParticipant.findFirstOrThrow({ where: { bookingId: id, userId: friend.userId } }),
    );
    await removeBookingPlayer({
      userId: booker.userId,
      bookingId: id,
      participantId: participant.id,
    });
    expect((await bells(friend.userId)).map((b) => [b.kind, b.title])).toEqual([
      ['BOOKING_PLAYER_REMOVED', 'Вече не сте в тази игра'],
    ]);

    // Added by the booker from people they have played with.
    await addCoPlayer({ userId: booker.userId, bookingId: id, playerUserId: friend.userId });
    expect((await bells(friend.userId)).at(-1)).toMatchObject({
      kind: 'BOOKING_PLAYER_ADDED',
      title: 'Иван ви добави в игра',
    });
    expect(await outbox()).toHaveLength(0);
  });

  // ─── the reminder ───────────────────────────────────────────────────

  describe('the 3-hour reminder', () => {
    // Sunday 25 October 2026: Sofia leaves summer time at 04:00 EEST (01:00Z).
    // A game at 05:00 EET is 03:00Z; three real hours before is 00:00Z, which
    // is 03:00 EEST on the wall clock: two wall-clock hours, three real ones.
    const START = new Date('2026-10-25T03:00:00Z');

    it('fires once, three real hours before, across the DST change', async () => {
      const id = await seedBooking(START);
      await addParticipant(id, friend.userId);

      // A wall-clock "3 hours before" (02:00 EEST = 23:00Z) is an hour early.
      expect(await sendBookingReminders({ now: new Date('2026-10-24T23:00:00Z') })).toEqual({
        claimed: 0,
        notified: 0,
      });
      expect(await sendBookingReminders({ now: new Date('2026-10-24T23:56:00Z') })).toMatchObject({
        claimed: 0,
      });
      expect(await sendBookingReminders({ now: new Date('2026-10-25T00:00:00Z') })).toEqual({
        claimed: 1,
        notified: 2,
      });
      // Every later run in the window, and a run racing it, claims nothing.
      const again = await Promise.all([
        sendBookingReminders({ now: new Date('2026-10-25T00:00:00Z') }),
        sendBookingReminders({ now: new Date('2026-10-25T00:05:00Z') }),
        sendBookingReminders({ now: new Date('2026-10-25T00:30:00Z') }),
      ]);
      expect(again.map((r) => r.claimed)).toEqual([0, 0, 0]);

      for (const who of [booker, friend]) {
        const reminders = (await bells(who.userId)).filter((b) => b.kind === 'BOOKING_REMINDER');
        expect(reminders).toHaveLength(1);
        expect(reminders[0]!.title).toBe('Играете след 3 часа');
        // The club's wall clock, after the change: 05:00.
        expect(reminders[0]!.body).toContain('05:00–06:00');
        const mail = (await outbox(who.userId)).find((o) => o.category === 'reminder')!;
        expect(mail.expiresAt).toEqual(START);
        expect(mail.text).toContain('05:00–06:00');
      }
    });

    it('not for a cancelled booking, nor one made less than 3 hours before its start, nor one past its window', async () => {
      await seedBooking(START, { status: 'CANCELLED' });
      // Starts 04:00Z, booked 01:30Z: 2 h 30 min ahead, its confirmation is fresh.
      await seedBooking(new Date(START.getTime() + HOUR), {
        createdAt: new Date('2026-10-25T01:30:00Z'),
      });
      // Starts 01:50Z: by the 00:00Z run it is under 2 hours away (the cron
      // was down); too late to be useful.
      await seedBooking(new Date('2026-10-25T01:50:00Z'));

      expect(await sendBookingReminders({ now: new Date('2026-10-25T00:00:00Z') })).toMatchObject({
        claimed: 0,
      });
      expect(await sendBookingReminders({ now: new Date('2026-10-25T01:45:00Z') })).toMatchObject({
        claimed: 0,
      });
      expect(await asAppSuperuser(db, (tx) => tx.notification.count())).toBe(0);
    });

    it('a cancel after the reminder was written: the reminder email is not sent, the cancellation is', async () => {
      const id = await seedBooking(START);
      await sendBookingReminders({ now: new Date('2026-10-25T00:00:00Z') });
      expect((await outbox(booker.userId)).map((o) => o.category)).toEqual(['reminder']);

      expect((await cancel(id, staff)).status).toBe(200);

      const { sent, provider } = recorder();
      const result = await drainEmailOutbox({ now: new Date('2026-10-25T00:01:00Z'), provider });
      expect(result).toMatchObject({ claimed: 2, sent: 1, skipped: 1 });
      expect(sent.map((m) => m.subject)).toEqual([
        expect.stringMatching(/^Клубът отмени резервацията ви/),
      ]);
      const reminder = (await outbox(booker.userId)).find((o) => o.category === 'reminder')!;
      expect(reminder).toMatchObject({ status: 'SKIPPED', lastError: 'booking-not-live' });
    });

    it('a cancel that commits first: the reminder is never claimed', async () => {
      const id = await seedBooking(START);
      await asAppSuperuser(db, (tx) =>
        tx.booking.update({ where: { id }, data: { status: 'CANCELLED' } }),
      );
      expect(await sendBookingReminders({ now: new Date('2026-10-25T00:00:00Z') })).toMatchObject({
        claimed: 0,
      });
    });
  });

  // ─── the drain ──────────────────────────────────────────────────────

  describe('the outbox drain', () => {
    const now = new Date('2036-07-01T10:00:00Z');

    it('sends to the address on the account at send time, idempotent per row, and marks it SENT', async () => {
      await book(booker);
      await setUser(booker.userId, { email: 'ivan.new@playerz.test' });
      const { sent, provider } = recorder();

      expect(await drainEmailOutbox({ now, provider })).toMatchObject({ claimed: 1, sent: 1 });
      const [row] = await outbox();
      expect(sent).toEqual([
        expect.objectContaining({
          to: 'ivan.new@playerz.test',
          idempotencyKey: `outbox-${row!.id}`,
        }),
      ]);
      expect(row).toMatchObject({ status: 'SENT', provider: 'resend', attempts: 1 });
      expect(await drainEmailOutbox({ now, provider })).toMatchObject({ claimed: 0 });
      expect(sent).toHaveLength(1);
    });

    it('re-checks the setting at send time', async () => {
      await book(booker);
      await setUser(booker.userId, { emailBookingConfirmations: false });
      const { sent, provider } = recorder();
      expect(await drainEmailOutbox({ now, provider })).toMatchObject({ skipped: 1 });
      expect(sent).toHaveLength(0);
      expect((await outbox())[0]).toMatchObject({ status: 'SKIPPED', lastError: 'opted-out' });
    });

    it('a failing provider: retried with backoff, then dead-lettered after the last attempt', async () => {
      await book(booker);
      const { sent, provider } = recorder(() => ({
        ok: false,
        permanent: false,
        error: 'smtp 421',
      }));

      let at = now;
      expect(await drainEmailOutbox({ now: at, provider })).toMatchObject({ retried: 1 });
      let [row] = await outbox();
      expect(row).toMatchObject({ status: 'PENDING', attempts: 1, lastError: 'smtp 421' });
      expect(row!.nextAttemptAt).toEqual(new Date(at.getTime() + 60_000));

      // Not due yet: nothing is claimed.
      expect(
        await drainEmailOutbox({ now: new Date(at.getTime() + 30_000), provider }),
      ).toMatchObject({ claimed: 0 });

      for (let attempt = 2; attempt <= EMAIL_MAX_ATTEMPTS; attempt++) {
        at = (await outbox())[0]!.nextAttemptAt;
        await drainEmailOutbox({ now: at, provider });
      }
      [row] = await outbox();
      expect(row).toMatchObject({ status: 'DEAD', attempts: EMAIL_MAX_ATTEMPTS });
      expect(sent).toHaveLength(EMAIL_MAX_ATTEMPTS);

      // Dead is dead: a later drain leaves it alone.
      expect(
        await drainEmailOutbox({ now: new Date(at.getTime() + 86_400_000), provider }),
      ).toMatchObject({ claimed: 0 });
    });

    it('a permanent refusal is dead-lettered at once', async () => {
      await book(booker);
      const { provider } = recorder(() => ({
        ok: false,
        permanent: true,
        error: 'validation_error',
      }));
      expect(await drainEmailOutbox({ now, provider })).toMatchObject({ dead: 1 });
      expect((await outbox())[0]).toMatchObject({ status: 'DEAD', attempts: 1 });
    });

    it('a row claimed by a drain that died is retried after its lease', async () => {
      await book(booker);
      // A drain that claims the row and then never comes back from the provider.
      let release!: (o: SendOutcome) => void;
      const hang: EmailProvider = {
        name: 'resend',
        send: () => new Promise<SendOutcome>((r) => (release = r)),
      };
      const stuck = drainEmailOutbox({ now, provider: hang });
      await new Promise((r) => setTimeout(r, 300));

      const { sent, provider } = recorder();
      // Inside its lease, nobody else takes it.
      expect(await drainEmailOutbox({ now, provider })).toMatchObject({ claimed: 0 });
      // After it, the next drain does.
      expect(
        await drainEmailOutbox({ now: new Date(now.getTime() + 5 * 60_000 + 1), provider }),
      ).toMatchObject({ sent: 1 });
      expect(sent).toHaveLength(1);

      release({ ok: true, messageId: null });
      await stuck;
    });

    it('staging: the log-only adapter whatever keys are set, so nothing is sent', async () => {
      await book(booker);
      const provider = selectEmailProvider({
        DEPLOY_ENV: 'staging',
        RESEND_API_KEY: 're_would_send',
        SMTP_HOST: 'smtp.would.send',
      });
      expect(provider.name).toBe('log');
      expect(await drainEmailOutbox({ now, provider })).toMatchObject({
        provider: 'log',
        sent: 1,
      });
      expect((await outbox())[0]).toMatchObject({ status: 'SENT', provider: 'log' });
    });

    it('a venue name cannot inject a header: the subject is one line, and the database refuses another', async () => {
      await asAppSuperuser(db, (tx) =>
        tx.venue.updateMany({ data: { name: 'Evil\r\nBcc: victim@x.bg' } }),
      );
      await book(booker);
      expect((await outbox())[0]!.subject).not.toMatch(/[\r\n]/);
      await expect(
        asAppSuperuser(db, (tx) =>
          tx.emailOutbox.updateMany({ data: { subject: 'a\nBcc: x@y.bg' } }),
        ),
      ).rejects.toThrow();
    });
  });

  // ─── the dedupe primitive ───────────────────────────────────────────

  it('one row per (event, recipient), and a daily key caps a conversation to one email a day (#375)', async () => {
    const send = (at: Date) =>
      deliver({
        userId: booker.userId,
        kind: 'MESSAGE_RECEIVED',
        dedupeKey: dailyDedupeKey('message', 'conv1', at),
        title: 'Ново съобщение',
        body: 'Мария: здрасти',
        email: { category: 'messages', subject: 'Ново съобщение', text: 'здрасти', locale: 'bg' },
      });
    expect(await send(new Date('2026-10-24T08:00:00Z'))).toEqual({ bell: true, email: true });
    expect(await send(new Date('2026-10-24T20:00:00Z'))).toEqual({ bell: false, email: false });
    // 00:30 Sofia on the 25th: a new day at the club.
    expect(await send(new Date('2026-10-24T21:30:00Z'))).toEqual({ bell: true, email: true });
    expect(await outbox(booker.userId)).toHaveLength(2);
  });

  // ─── the bell API ───────────────────────────────────────────────────

  describe('GET /me/notifications and POST /me/notifications/read', () => {
    const list = (who: TestIdentity | null, qs = '') =>
      listRoute(
        new NextRequest(`http://t/api/v1/me/notifications${qs}`, { headers: headers(who) }),
        NO_PARAMS,
      ).then(read);
    const markRead = (who: TestIdentity, body: unknown) =>
      readRoute(
        new NextRequest('http://t/api/v1/me/notifications/read', {
          method: 'POST',
          headers: headers(who),
          body: JSON.stringify(body),
        }),
        NO_PARAMS,
      ).then(read);
    const note = (who: TestIdentity, i: number) =>
      deliver({
        userId: who.userId,
        kind: 'BOOKING_CONFIRMED',
        dedupeKey: `test:${i}`,
        title: `#${i}`,
        body: 'b',
        href: '/me/bookings/x',
      });

    it('the caller’s own rows only, newest first, paged, with the unread count', async () => {
      for (let i = 1; i <= 5; i++) await note(booker, i);
      await note(friend, 99);

      const first = await list(booker, '?limit=2');
      expect(first.status).toBe(200);
      const data = first.body.data as unknown as {
        items: Array<{ id: string; title: string; read: boolean }>;
        nextCursor: string;
        unreadCount: number;
      };
      expect(data.items.map((n) => n.title)).toEqual(['#5', '#4']);
      expect(data.unreadCount).toBe(5);

      const rest = (await list(booker, `?limit=10&cursor=${data.nextCursor}`)).body
        .data as unknown as typeof data;
      expect(rest.items.map((n) => n.title)).toEqual(['#3', '#2', '#1']);
      expect(rest.nextCursor).toBeNull();
    });

    it('a cursor that is not the caller’s is a 400, not an empty page; signed out is 401', async () => {
      await note(friend, 1);
      const theirs = (await bells(friend.userId))[0]!.id;
      expect((await list(booker, `?cursor=${theirs}`)).status).toBe(400);
      expect((await list(booker, '?cursor=bad%00cursor')).status).toBe(400);
      expect((await list(null)).status).toBe(401);
    });

    it('marking someone else’s notification read is a 404 and changes nothing (IDOR)', async () => {
      await note(booker, 1);
      await note(friend, 2);
      const mine = (await bells(booker.userId))[0]!.id;
      const theirs = (await bells(friend.userId))[0]!.id;

      const refused = await markRead(booker, { ids: [mine, theirs] });
      expect(refused.status).toBe(404);
      expect((await bells(friend.userId))[0]!.readAt).toBeNull();
      expect((await bells(booker.userId))[0]!.readAt).toBeNull();

      const okRes = await markRead(booker, { ids: [mine] });
      expect(okRes.body.data).toEqual({ marked: 1, unreadCount: 0 });
      const firstRead = (await bells(booker.userId))[0]!.readAt;
      expect(firstRead).not.toBeNull();
      // Idempotent, and never re-stamps.
      expect((await markRead(booker, { ids: [mine] })).body.data).toEqual({
        marked: 0,
        unreadCount: 0,
      });
      expect((await bells(booker.userId))[0]!.readAt).toEqual(firstRead);
    });

    it('all: true marks every one of the caller’s, and nobody else’s', async () => {
      await note(booker, 1);
      await note(booker, 2);
      await note(friend, 3);
      expect((await markRead(booker, { all: true })).body.data).toEqual({
        marked: 2,
        unreadCount: 0,
      });
      expect((await bells(friend.userId))[0]!.readAt).toBeNull();
    });

    it('refuses a body it does not understand', async () => {
      expect((await markRead(booker, { ids: [] })).status).toBe(400);
      expect((await markRead(booker, { all: false })).status).toBe(400);
      expect((await markRead(booker, { all: true, userId: friend.userId })).status).toBe(400);
    });
  });

  describe('GET/PATCH /me/notification-settings', () => {
    const get = (who: TestIdentity) =>
      settingsGetRoute(
        new NextRequest('http://t/api/v1/me/notification-settings', { headers: headers(who) }),
        NO_PARAMS,
      ).then(read);
    const patch = (who: TestIdentity, body: unknown) =>
      settingsPatchRoute(
        new NextRequest('http://t/api/v1/me/notification-settings', {
          method: 'PATCH',
          headers: headers(who),
          body: JSON.stringify(body),
        }),
        NO_PARAMS,
      ).then(read);

    it('all on by default; one switch at a time; strict', async () => {
      expect((await get(booker)).body.data).toEqual({
        email: { confirmation: true, reminder: true, clubChanges: true, messages: true },
      });
      expect((await patch(booker, { email: { reminder: false } })).body.data).toEqual({
        email: { confirmation: true, reminder: false, clubChanges: true, messages: true },
      });
      expect((await get(friend)).body.data).toMatchObject({ email: { reminder: true } });
      expect((await patch(booker, { email: {} })).status).toBe(400);
      expect((await patch(booker, { email: { bell: false } })).status).toBe(400);
      expect((await patch(booker, { email: { reminder: 'no' } })).status).toBe(400);
    });
  });

  // ─── the cron routes ────────────────────────────────────────────────

  describe('the cron routes', () => {
    const OLD = process.env.CRON_SECRET;
    const SECRET = 'cron-secret-for-tests'; // pragma: allowlist secret
    afterEach(() => {
      process.env.CRON_SECRET = OLD;
    });
    const post = (route: typeof cronDrainRoute, secret?: string) =>
      route(
        new NextRequest('http://t/api/cron/x', {
          method: 'POST',
          headers: secret ? { 'x-cron-secret': secret } : {},
        }),
      );

    it('refuse without the secret, and with no secret configured', async () => {
      process.env.CRON_SECRET = SECRET;
      expect((await post(cronDrainRoute)).status).toBe(401);
      expect((await post(cronReminderRoute, 'wrong')).status).toBe(401);
      delete process.env.CRON_SECRET;
      expect((await post(cronDrainRoute, 'anything')).status).toBe(503);
    });

    it('run with it: the test environment has no provider, so the drain is log-only', async () => {
      process.env.CRON_SECRET = SECRET;
      await book(booker);
      const res = await post(cronDrainRoute, SECRET);
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ provider: 'log', sent: 1 });
      expect((await post(cronReminderRoute, SECRET)).status).toBe(200);
    });
  });
});
