import { NextRequest } from 'next/server';

import { DELETE as deleteMe, GET as getMeRoute } from '@/app/api/v1/me/route';
import { POST as confirmRoute } from '@/app/api/v1/me/phone/confirm/route';
import { POST as startRoute } from '@/app/api/v1/me/phone/start/route';
import { acceptBookingInvite, createBookingInviteLink } from '@/app-layer/usecases/booking-players';
import { noShowStanding } from '@/app-layer/usecases/booking-rules';
import { resolvePlayerTenant } from '@/app-layer/usecases/club-membership';
import { openPlayerConversation, sendMessage } from '@/app-layer/usecases/messaging';
import { askToJoin } from '@/app-layer/usecases/open-play';
import {
  assertPhoneConfirmed,
  confirmPhoneVerification,
  phoneStanding,
  startPhoneVerification,
} from '@/app-layer/usecases/phone-verification';
import { phoneFingerprint } from '@/lib/account/phone-fingerprint';
import { decryptField, isEncryptedValue } from '@/lib/security/encryption';
import type { CheckOutcome, StartOutcome } from '@/lib/sms/phone-verifier';

import { seedPlayer, signInAs, type TestIdentity } from '../helpers/auth';
import { prismaTestClient, seedTenant, seedVenue } from '../helpers/db';
import { confirmPhoneFor } from '../helpers/phone';
import { asAppSuperuser, asAppUser } from '../helpers/rls';

/**
 * A phone number confirmed by an SMS code (#500), against a real database.
 *
 * The SMS provider is replaced: `sent` records what would have been texted,
 * and CODE is the code that "arrived". Everything else is real: the
 * normalising, the limits, the encrypted column, the unique fingerprint, and
 * the standing a number carries.
 */
const CODE = '314159';
const sent: Array<{ to: string; locale: string }> = [];
let startAnswer: StartOutcome = { ok: true };
let checkAnswer: ((to: string, code: string) => CheckOutcome) | null = null;
let configured = true;
let required = false;

jest.mock('@/lib/sms/phone-verifier', () => ({
  phoneRequired: () => required,
  phoneVerifier: () =>
    configured
      ? {
          name: 'test',
          start: async (to: string, locale: string) => {
            if (startAnswer.ok) sent.push({ to, locale });
            return startAnswer;
          },
          check: async (to: string, code: string) =>
            checkAnswer
              ? checkAnswer(to, code)
              : code === CODE
                ? { ok: true }
                : { ok: false, reason: 'wrong' },
        }
      : null,
}));
// The request's language is its NEXT_LOCALE cookie; a route called directly has no store.
jest.mock('@/lib/i18n/chosen-locale', () => ({ chosenLocale: async () => 'en' }));

const db = prismaTestClient();
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** A number nobody else in this run uses: the limits are per number. */
const fresh = () => `+3598${Math.floor(10_000_000 + Math.random() * 89_999_999)}`;

async function account(): Promise<TestIdentity> {
  const u = await asAppSuperuser(db, (tx) =>
    tx.user.create({
      data: {
        email: `phone-${Math.random().toString(36).slice(2)}@playerz.test`,
        accountKind: 'PLAYER',
      },
      select: { id: true },
    }),
  );
  return signInAs(db, { userId: u.id, memberships: [] });
}

const row = (userId: string) =>
  asAppSuperuser(db, (tx) =>
    tx.user.findUniqueOrThrow({
      where: { id: userId },
      select: { phone: true, phoneHash: true, phoneVerifiedAt: true },
    }),
  );

beforeEach(() => {
  sent.length = 0;
  startAnswer = { ok: true };
  checkAnswer = null;
  configured = true;
  required = false;
});

describe('the phone step (#500)', () => {
  it('sends a code to the number in E.164, however it was typed, in the person’s language', async () => {
    const me = await account();
    const e164 = fresh();
    const national = `0${e164.slice(4)}`;
    const spaced = `${national.slice(0, 4)} ${national.slice(4, 7)} ${national.slice(7)}`;

    const res = await startPhoneVerification(me.userId, spaced, 'bg');
    expect(res.sent).toBe(true);
    expect(res.number).toContain('*');
    expect(res.number).not.toBe(e164);
    expect(sent).toEqual([{ to: e164, locale: 'bg' }]);
    // Nothing is stored until the code is confirmed.
    expect(await row(me.userId)).toEqual({ phone: null, phoneHash: null, phoneVerifiedAt: null });
  });

  it('refuses what is not a phone number, and what the provider says cannot get a code', async () => {
    const me = await account();
    for (const bad of ['', 'abc', '12', '0888', '+359 88 abc', '1'.repeat(30)]) {
      await expect(startPhoneVerification(me.userId, bad, 'bg')).rejects.toMatchObject({
        name: 'PhoneInvalidError',
      });
    }
    startAnswer = { ok: false, reason: 'invalid' };
    await expect(startPhoneVerification(me.userId, fresh(), 'bg')).rejects.toMatchObject({
      name: 'PhoneInvalidError',
    });
    expect(sent).toEqual([]);
  });

  it('the right code makes the number the account’s: encrypted, fingerprinted, dated', async () => {
    const me = await account();
    const e164 = fresh();
    await startPhoneVerification(me.userId, e164, 'bg');

    const done = await confirmPhoneVerification(me.userId, e164, CODE);
    expect(done).toMatchObject({ verified: true, inherited: 0 });

    const stored = await row(me.userId);
    expect(stored.phone).not.toBe(e164);
    expect(isEncryptedValue(stored.phone)).toBe(true);
    expect(decryptField(stored.phone!)).toBe(e164);
    expect(stored.phoneHash).toBe(phoneFingerprint(e164));
    expect(stored.phoneVerifiedAt).toBeInstanceOf(Date);

    expect(await phoneStanding(me.userId)).toMatchObject({
      verified: true,
      number: done.number,
      required: false,
    });
  });

  it('a wrong code confirms nothing; an expired one says to ask again', async () => {
    const me = await account();
    const e164 = fresh();
    await startPhoneVerification(me.userId, e164, 'bg');

    await expect(confirmPhoneVerification(me.userId, e164, '000000')).rejects.toMatchObject({
      name: 'PhoneCodeWrongError',
    });
    checkAnswer = () => ({ ok: false, reason: 'expired' });
    await expect(confirmPhoneVerification(me.userId, e164, CODE)).rejects.toMatchObject({
      name: 'PhoneCodeExpiredError',
    });
    checkAnswer = () => ({ ok: false, reason: 'limited' });
    await expect(confirmPhoneVerification(me.userId, e164, CODE)).rejects.toMatchObject({
      name: 'RateLimitedError',
    });
    expect(await row(me.userId)).toEqual({ phone: null, phoneHash: null, phoneVerifiedAt: null });
  });

  it('the code is checked against the number it was typed for', async () => {
    const me = await account();
    const [mine, other] = [fresh(), fresh()];
    await startPhoneVerification(me.userId, mine, 'bg');
    const asked: string[] = [];
    checkAnswer = (to, code) => {
      asked.push(to);
      return to === mine && code === CODE ? { ok: true } : { ok: false, reason: 'expired' };
    };
    await expect(confirmPhoneVerification(me.userId, other, CODE)).rejects.toMatchObject({
      name: 'PhoneCodeExpiredError',
    });
    expect(asked).toEqual([other]);
    expect((await row(me.userId)).phoneHash).toBeNull();
  });
});

describe('one number, one account (#500)', () => {
  it('a number that confirms another account is refused, and only after the code', async () => {
    const [holder, me] = await Promise.all([account(), account()]);
    const e164 = await confirmPhoneFor(db, holder.userId);

    // `start` says nothing about it: the code is sent as to any number.
    await expect(startPhoneVerification(me.userId, e164, 'bg')).resolves.toMatchObject({
      sent: true,
    });
    // A wrong code learns nothing either.
    await expect(confirmPhoneVerification(me.userId, e164, '000000')).rejects.toMatchObject({
      name: 'PhoneCodeWrongError',
    });
    // Whoever holds the phone is told.
    await expect(confirmPhoneVerification(me.userId, e164, CODE)).rejects.toMatchObject({
      name: 'PhoneInUseError',
    });
    expect((await row(me.userId)).phoneHash).toBeNull();
    expect((await row(holder.userId)).phoneHash).toBe(phoneFingerprint(e164));
  });

  it('confirming the same number again is not a clash with oneself', async () => {
    const me = await account();
    const e164 = fresh();
    await confirmPhoneVerification(me.userId, e164, CODE);
    await expect(confirmPhoneVerification(me.userId, e164, CODE)).resolves.toMatchObject({
      verified: true,
    });
  });

  it('changing the number frees the old one for somebody else', async () => {
    const [me, other] = await Promise.all([account(), account()]);
    const [first, second] = [fresh(), fresh()];
    await confirmPhoneVerification(me.userId, first, CODE);
    await confirmPhoneVerification(me.userId, second, CODE);
    expect((await row(me.userId)).phoneHash).toBe(phoneFingerprint(second));

    await expect(confirmPhoneVerification(other.userId, first, CODE)).resolves.toMatchObject({
      verified: true,
    });
  });

  it('two accounts confirming one number at once: the database lets one through', async () => {
    const [a, b] = await Promise.all([account(), account()]);
    const e164 = fresh();
    const results = await Promise.allSettled([
      confirmPhoneVerification(a.userId, e164, CODE),
      confirmPhoneVerification(b.userId, e164, CODE),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const lost = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(lost.reason).toMatchObject({ name: 'PhoneInUseError' });
    const holders = await asAppSuperuser(db, (tx) =>
      tx.user.count({ where: { phoneHash: phoneFingerprint(e164) } }),
    );
    expect(holders).toBe(1);
  });
});

describe('limits on the phone step (#500)', () => {
  it('one number is texted at most three times an hour, whoever asks', async () => {
    const e164 = fresh();
    const askers = await Promise.all([account(), account(), account(), account()]);
    for (const who of askers.slice(0, 3)) await startPhoneVerification(who.userId, e164, 'bg');
    await expect(startPhoneVerification(askers[3]!.userId, e164, 'bg')).rejects.toMatchObject({
      name: 'RateLimitedError',
    });
    expect(sent).toHaveLength(3);
  });

  it('one account asks for at most five codes an hour, whatever the numbers', async () => {
    const me = await account();
    for (let i = 0; i < 5; i++) await startPhoneVerification(me.userId, fresh(), 'bg');
    await expect(startPhoneVerification(me.userId, fresh(), 'bg')).rejects.toMatchObject({
      name: 'RateLimitedError',
    });
    expect(sent).toHaveLength(5);
  });

  it('one account guesses at most ten times an hour', async () => {
    const me = await account();
    const e164 = fresh();
    for (let i = 0; i < 10; i++) {
      await expect(confirmPhoneVerification(me.userId, e164, '000000')).rejects.toMatchObject({
        name: 'PhoneCodeWrongError',
      });
    }
    // Even the right code, now.
    await expect(confirmPhoneVerification(me.userId, e164, CODE)).rejects.toMatchObject({
      name: 'RateLimitedError',
    });
  });

  it('with no SMS provider the step answers "unavailable" and confirms nothing', async () => {
    configured = false;
    const me = await account();
    await expect(startPhoneVerification(me.userId, fresh(), 'bg')).rejects.toMatchObject({
      name: 'PhoneVerifyUnavailableError',
    });
    await expect(confirmPhoneVerification(me.userId, fresh(), CODE)).rejects.toMatchObject({
      name: 'PhoneVerifyUnavailableError',
    });
  });
});

describe('the gate (#500)', () => {
  it('with the rule off nobody is held back', async () => {
    const me = await account();
    await expect(assertPhoneConfirmed(me.userId)).resolves.toBeUndefined();
  });

  it('with the rule on, an account needs a confirmed number', async () => {
    required = true;
    const me = await account();
    await expect(assertPhoneConfirmed(me.userId)).rejects.toMatchObject({
      name: 'PhoneRequiredError',
    });
    await confirmPhoneVerification(me.userId, fresh(), CODE);
    await expect(assertPhoneConfirmed(me.userId)).resolves.toBeUndefined();
    expect((await phoneStanding(me.userId))?.required).toBe(true);
  });
});

describe('what needs a confirmed number, once the rule is on (#500)', () => {
  const HELD = { name: 'PhoneRequiredError' };

  async function clubWithBooking() {
    const club = await seedTenant({ name: 'Клуб Гама' });
    const court = await seedVenue(club.tenantId);
    const booker = await seedPlayer(db, club.tenantId, 'gate-booker');
    const start = new Date(Date.now() + 3 * DAY);
    const booking = await asAppSuperuser(db, (tx) =>
      tx.booking.create({
        data: {
          tenantId: club.tenantId,
          resourceId: court.resourceId,
          startTs: start,
          endTs: new Date(start.getTime() + HOUR),
          bookedByUserId: booker,
          totalCents: 2400,
          status: 'CONFIRMED',
          idempotencyKey: `gate-${Math.random()}`,
        },
        select: { id: true },
      }),
    );
    return { club, booker, bookingId: booking.id };
  }

  it('booking: refused before the account becomes anybody’s player, then let through', async () => {
    required = true;
    const { club } = await clubWithBooking();
    const me = await account();

    await expect(
      resolvePlayerTenant(me.userId, club.tenantSlug, { createIfAbsent: true }),
    ).rejects.toMatchObject(HELD);
    const joined = () =>
      asAppSuperuser(db, (tx) => tx.tenantMembership.count({ where: { userId: me.userId } }));
    expect(await joined()).toBe(0);

    await confirmPhoneFor(db, me.userId);
    await expect(
      resolvePlayerTenant(me.userId, club.tenantSlug, { createIfAbsent: true }),
    ).resolves.toMatchObject({ tenantId: club.tenantId });
    expect(await joined()).toBe(1);
  });

  it('booking: reading one’s own bookings at a club is not held back', async () => {
    required = true;
    const { club } = await clubWithBooking();
    const me = await account();
    // createIfAbsent: false is every read; it answers "not a member", not the gate.
    await expect(
      resolvePlayerTenant(me.userId, club.tenantSlug, { createIfAbsent: false }),
    ).resolves.toBeNull();
  });

  it('joining a booking by link: refused, then let through', async () => {
    required = true;
    const { booker, bookingId } = await clubWithBooking();
    const link = await createBookingInviteLink({ userId: booker, bookingId });
    const me = await account();

    await expect(
      acceptBookingInvite({ userId: me.userId, token: link.token }),
    ).rejects.toMatchObject(HELD);
    await confirmPhoneFor(db, me.userId);
    await expect(
      acceptBookingInvite({ userId: me.userId, token: link.token }),
    ).resolves.toMatchObject({ joined: true });
  });

  it('asking to join a game: refused before the game is even looked at', async () => {
    required = true;
    const me = await account();
    await expect(askToJoin({ userId: me.userId, gameId: 'no-such-game' })).rejects.toMatchObject(
      HELD,
    );
    await confirmPhoneFor(db, me.userId);
    // Past the gate: now it is about the game.
    await expect(askToJoin({ userId: me.userId, gameId: 'no-such-game' })).rejects.toMatchObject({
      code: 'GAME_NOT_FOUND',
    });
  });

  it('writing a message: a player is asked, a club’s staff are not', async () => {
    required = true;
    const [me, other] = await Promise.all([account(), account()]);
    await confirmPhoneFor(db, other.userId);
    const { id } = await openPlayerConversation(
      { kind: 'player', userId: other.userId },
      me.userId,
    );

    await expect(
      sendMessage({ kind: 'player', userId: me.userId }, id, 'Здравей'),
    ).rejects.toMatchObject(HELD);
    await confirmPhoneFor(db, me.userId);
    await expect(
      sendMessage({ kind: 'player', userId: me.userId }, id, 'Здравей'),
    ).resolves.toMatchObject({ id: expect.any(String) });

    // Staff with no number of their own, writing for the club: never the gate.
    const { club } = await clubWithBooking();
    const staff = await account();
    await expect(
      sendMessage(
        { kind: 'club', userId: staff.userId, tenantId: club.tenantId },
        'no-such-chat',
        'Здравейте',
      ),
    ).rejects.not.toMatchObject(HELD);
  });

  it('with the rule off, none of them asks', async () => {
    const { club, booker, bookingId } = await clubWithBooking();
    const link = await createBookingInviteLink({ userId: booker, bookingId });
    const me = await account();
    await expect(
      resolvePlayerTenant(me.userId, club.tenantSlug, { createIfAbsent: true }),
    ).resolves.not.toBeNull();
    await expect(
      acceptBookingInvite({ userId: me.userId, token: link.token }),
    ).resolves.toMatchObject({ joined: true });
  });
});

describe('a number carries its no-show standing (#500)', () => {
  const callDelete = async (who: TestIdentity) =>
    (
      await deleteMe(
        new NextRequest('http://localhost:3000/api/v1/me', {
          method: 'DELETE',
          headers: { authorization: `Bearer ${who.bearer}` },
        }),
        {},
      )
    ).status;

  it('a deleted account’s standing passes to a new account, with a new address, that confirms the number', async () => {
    const club = await seedTenant({ name: 'Клуб Алфа' });
    const court = await seedVenue(club.tenantId);
    const old = await signInAs(db, {
      userId: await seedPlayer(db, club.tenantId, 'carried-phone'),
      memberships: [],
    });
    const e164 = await confirmPhoneFor(db, old.userId);
    for (const days of [5, 15, 25]) {
      await asAppSuperuser(db, (tx) =>
        tx.booking.create({
          data: {
            tenantId: club.tenantId,
            resourceId: court.resourceId,
            startTs: new Date(Date.now() - days * DAY),
            endTs: new Date(Date.now() - days * DAY + HOUR),
            bookedByUserId: old.userId,
            totalCents: 2400,
            status: 'NO_SHOW',
            idempotencyKey: `noshow-${Math.random()}`,
          },
        }),
      );
    }

    expect(await callDelete(old)).toBe(204);
    // The tombstone holds no number; the fingerprint waits on the carried rows.
    expect(await row(old.userId)).toEqual({ phone: null, phoneHash: null, phoneVerifiedAt: null });
    const carried = await asAppSuperuser(db, (tx) =>
      tx.noShowCarry.findMany({
        where: { deletedUserId: old.userId },
        select: { phoneFingerprint: true, inheritedByUserId: true },
      }),
    );
    expect(carried).toHaveLength(3);
    expect(new Set(carried.map((c) => c.phoneFingerprint))).toEqual(
      new Set([phoneFingerprint(e164)]),
    );

    // A different address altogether: only the phone links the two.
    const next = await account();
    expect(
      await asAppUser(db, club.tenantId, (tx) => noShowStanding(tx, club.tenantId, next.userId)),
    ).toMatchObject({ blocked: false });

    const done = await confirmPhoneVerification(next.userId, e164, CODE);
    expect(done.inherited).toBe(3);
    expect(
      await asAppUser(db, club.tenantId, (tx) => noShowStanding(tx, club.tenantId, next.userId)),
    ).toMatchObject({ recentNoShows: 3, blocked: true });

    // Once: confirming again takes nothing over twice.
    expect((await confirmPhoneVerification(next.userId, e164, CODE)).inherited).toBe(0);
  });

  it('an account with no standing leaves nothing under its number', async () => {
    const me = await account();
    await confirmPhoneFor(db, me.userId);
    expect(await callDelete(me)).toBe(204);
    const carried = await asAppSuperuser(db, (tx) =>
      tx.noShowCarry.count({ where: { deletedUserId: me.userId } }),
    );
    expect(carried).toBe(0);
  });
});

describe('POST /api/v1/me/phone/start and /confirm (#500)', () => {
  const post = async (route: typeof startRoute, who: TestIdentity | null, body: unknown) => {
    const res = await route(
      new NextRequest('http://localhost:3000/api/v1/me/phone', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(who ? { authorization: `Bearer ${who.bearer}` } : {}),
        },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({}) },
    );
    return {
      status: res.status,
      body: (await res.json()) as {
        data: Record<string, unknown> & { phone?: Record<string, unknown> };
        error: { code: string };
      },
    };
  };

  it('needs a session', async () => {
    expect((await post(startRoute, null, { phone: fresh() })).status).toBe(401);
    expect((await post(confirmRoute, null, { phone: fresh(), code: CODE })).status).toBe(401);
  });

  it('start then confirm: the account comes back with its number confirmed and hidden', async () => {
    const me = await account();
    const e164 = fresh();

    const started = await post(startRoute, me, { phone: e164 });
    expect(started.status).toBe(200);
    expect(started.body.data).toEqual({ sent: true, number: expect.stringContaining('*') });
    expect(sent).toEqual([{ to: e164, locale: 'en' }]);

    // The code as people read it out, with a space.
    const confirmed = await post(confirmRoute, me, {
      phone: e164,
      code: `${CODE.slice(0, 3)} ${CODE.slice(3)}`,
    });
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.data.phone).toEqual({
      required: false,
      verified: true,
      number: started.body.data.number,
    });
    expect(JSON.stringify(confirmed.body)).not.toContain(e164);

    const me2 = await getMeRoute(
      new NextRequest('http://localhost:3000/api/v1/me', {
        headers: { authorization: `Bearer ${me.bearer}` },
      }),
      {},
    );
    expect(((await me2.json()) as { data: { phone: unknown } }).data.phone).toEqual(
      confirmed.body.data.phone,
    );
  });

  it('answers each refusal with its own code', async () => {
    const [holder, me] = await Promise.all([account(), account()]);
    const taken = await confirmPhoneFor(db, holder.userId);

    expect(await post(startRoute, me, { phone: 'not a phone' })).toMatchObject({
      status: 400,
      body: { error: { code: 'PHONE_INVALID' } },
    });
    expect(await post(confirmRoute, me, { phone: fresh(), code: '000000' })).toMatchObject({
      status: 400,
      body: { error: { code: 'PHONE_CODE_WRONG' } },
    });
    expect(await post(confirmRoute, me, { phone: taken, code: CODE })).toMatchObject({
      status: 409,
      body: { error: { code: 'PHONE_IN_USE' } },
    });
    // A body that is not the schema's: letters for a code, an extra field.
    expect((await post(confirmRoute, me, { phone: fresh(), code: 'abcdef' })).status).toBe(400);
    expect((await post(startRoute, me, { phone: fresh(), extra: 1 })).status).toBe(400);

    configured = false;
    expect(await post(startRoute, me, { phone: fresh() })).toMatchObject({
      status: 503,
      body: { error: { code: 'PHONE_VERIFY_UNAVAILABLE' } },
    });
  });
});
