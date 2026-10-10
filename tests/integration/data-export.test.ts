import { NextRequest } from 'next/server';

import { GET as exportRoute } from '@/app/api/v1/me/export/route';
import { DELETE as deleteMe } from '@/app/api/v1/me/route';
import { clearAllRateLimits } from '@/lib/security/rate-limit';

import { seedPlayer, signInAs, type TestIdentity } from '../helpers/auth';
import { prismaTestClient, seedTenant, seedVenue, type SeededTenant } from '../helpers/db';
import { asAppSuperuser } from '../helpers/rls';
import { EXPORT_EXCLUDED_COLUMNS } from '../helpers/export-excluded';

/**
 * "Изтегли моите данни" (#370): `GET /api/v1/me/export`, against a real
 * database. Every section is there with the person's own data, and nothing
 * else is: no secret, no token, nobody else's email, phone or contact details,
 * and none of a club's own notes. The one place another person's name may
 * appear is the person's own bell, word for word (data-export.ts says why).
 */
const db = prismaTestClient();
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const SECRETS = {
  passwordHash: '$2a$04$exportTestHashThatMustNeverLeave', // pragma: allowlist secret
  mfaSecret: 'v1:export-test-envelope-must-never-leave', // pragma: allowlist secret
  sessionToken: 'session-token-hash-must-never-leave',
  refreshToken: 'refresh-token-hash-must-never-leave',
  pushEndpoint: 'https://push.test/endpoint-must-never-leave',
  p256dh: 'push-key-must-never-leave',
  pushAuth: 'push-auth-must-never-leave',
  deviceToken: 'apns-device-token-must-never-leave',
  linkHash: 'invite-link-hash-must-never-leave',
  recoveryCode: 'recovery-code-hash-must-never-leave',
};

/** What is somebody else's, or the club's own: none of it may leave in her file. */
const NOT_HERS = {
  coPlayerPhone: '+359888999000',
  coPlayerEmailPrefix: 'coplayer-',
  participantGuestName: 'Гост Гостев',
  participantGuestEmail: 'guest@example.bg',
  bookersDeskPhone: '+359877555444',
  bookersSessionIp: '198.51.100.99',
  bookersBell: 'Само за Петър',
  clubTag: 'вип-клиентка',
  deskNote: 'бележка на рецепцията',
  seriesNote: 'винаги корт 1, бележка на клуба',
};

async function download(who: TestIdentity) {
  const res = await exportRoute(
    new NextRequest('http://localhost:3000/api/v1/me/export', {
      headers: { authorization: `Bearer ${who.bearer}` },
    }),
    {},
  );
  const text = await res.text();
  return { res, text, json: JSON.parse(text) as Record<string, unknown> };
}

/** Every key at any depth of a JSON value. */
function keysOf(value: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) value.forEach((v) => keysOf(v, out));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      out.add(k);
      keysOf(v, out);
    }
  }
  return out;
}

describe('GET /api/v1/me/export (#370)', () => {
  let club: SeededTenant;
  let court: { venueId: string; venueSlug: string; resourceId: string };
  let player: TestIdentity;
  let mineId: string;
  let deskId: string;
  let theirsId: string;

  beforeEach(async () => {
    await clearAllRateLimits();
    club = await seedTenant({ name: 'Клуб Алфа' });
    court = await seedVenue(club.tenantId, { name: 'Алфа Кортове' });
    const userId = await seedPlayer(db, club.tenantId, 'exporting');
    const otherId = await seedPlayer(db, club.tenantId, 'coplayer');
    player = await signInAs(db, { userId, memberships: [] });

    const past = new Date(Date.now() - 3 * DAY);
    await asAppSuperuser(db, async (tx) => {
      await tx.user.update({
        where: { id: userId },
        data: {
          name: 'Мария Иванова',
          phone: '+359888000111',
          // Our copy of her picture (#458), which the export shows as our URL.
          avatarUrl: `avatars/${userId}/google-${'b'.repeat(32)}.webp`,
          passwordHash: SECRETS.passwordHash,
          mfaSecret: SECRETS.mfaSecret,
          emailBookingReminders: false,
        },
      });
      await tx.user.update({
        where: { id: otherId },
        data: { name: 'Петър Съиграч', phone: NOT_HERS.coPlayerPhone },
      });
      await tx.playerSportLevel.create({ data: { userId, sport: 'TENNIS', level: 3 } });
      await tx.playerProfile.create({
        data: { userId, displayName: 'Мария', bio: 'Обичам тенис' },
      });
      await tx.userSession.create({
        data: {
          userId,
          tokenHash: SECRETS.sessionToken,
          refreshTokenHash: SECRETS.refreshToken,
          expiresAt: new Date(Date.now() + DAY),
          ipAddress: '198.51.100.4',
          userAgent: 'Firefox',
        },
      });
      // The co-player's own session: not hers.
      await tx.userSession.create({
        data: {
          userId: otherId,
          tokenHash: `other-${Math.random()}`,
          expiresAt: new Date(Date.now() + DAY),
          ipAddress: NOT_HERS.bookersSessionIp,
        },
      });
      await tx.accountSecurityEvent.create({
        data: {
          userId,
          action: 'MFA_STEP_UP_SUCCEEDED',
          detailsJson: { method: 'totp' },
          ipAddress: '198.51.100.5',
          userAgent: 'Safari',
        },
      });
      await tx.mfaRecoveryCode.create({ data: { userId, codeHash: SECRETS.recoveryCode } });
      await tx.pushSubscription.create({
        data: {
          userId,
          endpoint: SECRETS.pushEndpoint,
          p256dh: SECRETS.p256dh,
          auth: SECRETS.pushAuth,
          userAgent: 'Chrome on Android',
        },
      });
      await tx.deviceToken.create({
        data: {
          userId,
          deviceToken: SECRETS.deviceToken,
          bundleId: 'bg.playerz',
          deviceName: 'iPhone на Мария',
        },
      });

      const mine = await tx.booking.create({
        data: {
          tenantId: club.tenantId,
          resourceId: court.resourceId,
          startTs: past,
          endTs: new Date(past.getTime() + HOUR),
          bookedByUserId: userId,
          totalCents: 3000,
          status: 'COMPLETED',
          notes: 'Ще дойда с ракетите си',
          idempotencyKey: `export-${Math.random()}`,
        },
      });
      mineId = mine.id;
      // A booking the club's desk entered for her: the contact it took is
      // hers, the note is the desk's.
      const desk = await tx.booking.create({
        data: {
          tenantId: club.tenantId,
          resourceId: court.resourceId,
          startTs: new Date(past.getTime() - DAY),
          endTs: new Date(past.getTime() - DAY + HOUR),
          bookedByUserId: userId,
          channel: 'DESK',
          guestName: 'Мария (рецепция)',
          guestPhone: '+359888000222',
          notes: NOT_HERS.deskNote,
          totalCents: 2400,
          status: 'NO_SHOW',
          idempotencyKey: `export-${Math.random()}`,
        },
      });
      deskId = desk.id;
      const theirs = await tx.booking.create({
        data: {
          tenantId: club.tenantId,
          resourceId: court.resourceId,
          startTs: new Date(past.getTime() + 2 * HOUR),
          endTs: new Date(past.getTime() + 3 * HOUR),
          bookedByUserId: otherId,
          channel: 'DESK',
          guestPhone: NOT_HERS.bookersDeskPhone,
          totalCents: 2400,
          status: 'COMPLETED',
          idempotencyKey: `export-${Math.random()}`,
        },
      });
      theirsId = theirs.id;
      await tx.bookingParticipant.create({
        data: { tenantId: club.tenantId, bookingId: theirs.id, userId, position: 2 },
      });
      // A guest the co-player named, with an address: theirs, not hers.
      await tx.bookingParticipant.create({
        data: {
          tenantId: club.tenantId,
          bookingId: theirs.id,
          guestName: NOT_HERS.participantGuestName,
          guestEmail: NOT_HERS.participantGuestEmail,
          position: 3,
        },
      });
      await tx.bookingSeries.create({
        data: {
          tenantId: club.tenantId,
          resourceId: court.resourceId,
          startTime: '19:00',
          durationMinutes: 60,
          timezone: 'Europe/Sofia',
          firstDate: new Date('2026-11-03'),
          lastDate: new Date('2026-12-29'),
          customerName: 'Мария Иванова',
          customerPhone: '+359888000111',
          customerUserId: userId,
          notes: NOT_HERS.seriesNote,
          priceCents: 2000,
          idempotencyKey: `series-${Math.random()}`,
        },
      });
      await tx.creditLedgerEntry.create({
        data: {
          tenantId: club.tenantId,
          userId,
          deltaCents: 1500,
          reason: 'REFUND_CREDIT',
          refType: 'booking',
          refId: mine.id,
          balanceAfterCents: 1500,
        },
      });
      await tx.creditLedgerEntry.create({
        data: {
          tenantId: club.tenantId,
          userId,
          deltaCents: -500,
          reason: 'SPEND',
          balanceAfterCents: 1000,
        },
      });
      await tx.playerVenueRelationship.create({
        data: {
          tenantId: club.tenantId,
          playerUserId: userId,
          noShowCount: 1,
          tags: [NOT_HERS.clubTag],
        },
      });
      await tx.notification.create({
        data: {
          userId,
          kind: 'BOOKING_PLAYER_JOINED',
          title: 'Петър Съиграч се включи в играта',
          body: 'Алфа Кортове',
          refType: 'booking',
          refId: mine.id,
        },
      });
      await tx.notification.create({
        data: {
          userId: otherId,
          kind: 'BOOKING_CONFIRMED',
          title: NOT_HERS.bookersBell,
          body: 'x',
        },
      });
      await tx.emailOutbox.create({
        data: {
          userId,
          kind: 'BOOKING_CONFIRMED',
          category: 'confirmation',
          dedupeKey: `booking:${mine.id}:confirmed`,
          locale: 'bg',
          subject: 'Потвърдена резервация',
          text: 'Здравейте, Мария',
        },
      });
      await tx.bookingInviteLink.create({
        data: {
          tenantId: club.tenantId,
          bookingId: mine.id,
          tokenHash: SECRETS.linkHash,
          createdByUserId: userId,
          expiresAt: mine.startTs,
        },
      });
      await tx.review.create({
        data: {
          tenantId: club.tenantId,
          venueId: court.venueId,
          authorUserId: userId,
          rating: 4,
          body: 'Хубави кортове',
          bookingId: mine.id,
          status: 'PUBLISHED',
        },
      });
    });
  });

  it('is a JSON attachment named playerz-data-YYYY-MM-DD.json, never cached', async () => {
    const { res } = await download(player);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(res.headers.get('content-disposition')).toMatch(
      /^attachment; filename="playerz-data-\d{4}-\d{2}-\d{2}\.json"$/,
    );
    expect(res.headers.get('cache-control')).toBe('private, no-store');
  });

  it('every section is there, with the person’s own data', async () => {
    const base = process.env.MEDIA_PUBLIC_BASE_URL;
    process.env.MEDIA_PUBLIC_BASE_URL = 'https://media.playerz.test';
    let json: Awaited<ReturnType<typeof download>>['json'];
    try {
      ({ json } = await download(player));
    } finally {
      if (base === undefined) delete process.env.MEDIA_PUBLIC_BASE_URL;
      else process.env.MEDIA_PUBLIC_BASE_URL = base;
    }
    expect(Object.keys(json)).toEqual([
      'format',
      'version',
      'exportedAt',
      'profile',
      'signIn',
      'devices',
      'memberships',
      'bookings',
      'weeklySeries',
      'credit',
      'noShowStanding',
      'reviews',
      'notifications',
      'notificationSettings',
      'inviteLinks',
      'messages',
    ]);
    expect(json.version).toBe(3);
    expect(json.profile).toMatchObject({
      id: player.userId,
      name: 'Мария Иванова',
      phone: '+359888000111',
      avatarUrl: `https://media.playerz.test/avatars/${player.userId}/google-${'b'.repeat(32)}.webp`,
      accountKind: 'PLAYER',
      sports: [{ sport: 'TENNIS', level: 3 }],
      playerProfile: { displayName: 'Мария', bio: 'Обичам тенис' },
    });
    expect(json.memberships).toEqual([
      expect.objectContaining({ club: 'Клуб Алфа', role: 'PLAYER', status: 'ACTIVE' }),
    ]);
    expect(json.reviews).toEqual([
      expect.objectContaining({ venue: 'Алфа Кортове', rating: 4, text: 'Хубави кортове' }),
    ]);
    expect(json.notificationSettings).toEqual({
      email: { bookingConfirmations: true, bookingReminders: false, clubChanges: true },
    });
    expect(json.inviteLinks).toEqual([expect.objectContaining({ bookingId: mineId })]);
  });

  it('signing in: her sessions with where they came from, and the second step’s log', async () => {
    const { json } = await download(player);
    const signIn = json.signIn as Record<string, unknown>;
    expect(signIn).toMatchObject({ providerAccounts: [], twoStepVerification: false });
    // signInAs records a session too; hers are all there, the seeded one with its address.
    expect(signIn.sessions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ipAddress: '198.51.100.4', userAgent: 'Firefox', endedAt: null }),
      ]),
    );
    expect(signIn.securityEvents).toEqual([
      expect.objectContaining({
        action: 'MFA_STEP_UP_SUCCEEDED',
        ipAddress: '198.51.100.5',
        userAgent: 'Safari',
        details: { method: 'totp' },
      }),
    ]);
    expect(json.devices).toEqual({
      apps: [expect.objectContaining({ deviceName: 'iPhone на Мария', app: 'bg.playerz' })],
      browsers: [expect.objectContaining({ userAgent: 'Chrome on Android' })],
    });
  });

  it('bookings: her note on an online one, the contact the desk took on a desk one, never the desk’s note', async () => {
    const { json } = await download(player);
    const bookings = json.bookings as {
      asBooker: Array<Record<string, unknown>>;
      asPlayer: Array<Record<string, unknown>>;
    };
    expect(bookings.asBooker).toEqual([
      expect.objectContaining({
        id: mineId,
        venue: 'Алфа Кортове',
        court: 'Court 1',
        price: { cents: 3000, currency: 'EUR' },
        status: 'COMPLETED',
        channel: 'ONLINE',
        note: 'Ще дойда с ракетите си',
        contactGivenToClub: null,
        addedPlayers: 0,
      }),
      expect.objectContaining({
        id: deskId,
        channel: 'DESK',
        status: 'NO_SHOW',
        note: null,
        contactGivenToClub: { name: 'Мария (рецепция)', phone: '+359888000222', email: null },
      }),
    ]);
    // Where she was added: how many played, never who, and nothing the booker gave.
    expect(bookings.asPlayer).toEqual([
      expect.objectContaining({ id: theirsId, venue: 'Алфа Кортове', addedPlayers: 2 }),
    ]);
    expect(Object.keys(bookings.asPlayer[0]!)).not.toContain('contactGivenToClub');
    expect(Object.keys(bookings.asPlayer[0]!)).not.toContain('note');
  });

  it('a weekly series, her credit, and her no-show standing at the club', async () => {
    const { json } = await download(player);
    expect(json.weeklySeries).toEqual([
      expect.objectContaining({
        club: 'Клуб Алфа',
        venue: 'Алфа Кортове',
        startTime: '19:00',
        firstDate: '2026-11-03',
        lastDate: '2026-12-29',
        priceCents: 2000,
        contactGivenToClub: { name: 'Мария Иванова', phone: '+359888000111' },
      }),
    ]);
    expect(json.credit).toEqual({
      balances: [{ club: 'Клуб Алфа', balanceCents: 1000, currency: 'EUR' }],
      ledger: [
        expect.objectContaining({
          club: 'Клуб Алфа',
          deltaCents: 1500,
          balanceAfterCents: 1500,
          reason: 'REFUND_CREDIT',
          ref: { type: 'booking', id: mineId },
        }),
        expect.objectContaining({ deltaCents: -500, reason: 'SPEND', ref: null }),
      ],
    });
    expect(json.noShowStanding).toEqual([
      {
        club: 'Клуб Алфа',
        recentNoShows: 1,
        blocked: false,
        countedOverDays: 90,
        blockedFrom: 3,
        blockLiftedAt: null,
      },
    ]);
  });

  it('notifications: her bell, word for word, and the emails playerz sent her', async () => {
    const { json } = await download(player);
    const notifications = json.notifications as {
      bell: Array<Record<string, unknown>>;
      email: Array<Record<string, unknown>>;
    };
    expect(notifications.bell).toEqual([
      expect.objectContaining({
        kind: 'BOOKING_PLAYER_JOINED',
        title: 'Петър Съиграч се включи в играта',
        readAt: null,
      }),
    ]);
    expect(notifications.email).toEqual([
      expect.objectContaining({
        kind: 'BOOKING_CONFIRMED',
        subject: 'Потвърдена резервация',
        text: 'Здравейте, Мария',
        status: 'PENDING',
      }),
    ]);
  });

  it('carries no secret, no token, nothing of anybody else’s and none of the club’s notes', async () => {
    const { text, json } = await download(player);
    for (const [what, value] of Object.entries(SECRETS)) {
      expect({ what, leaked: text.includes(value) }).toEqual({ what, leaked: false });
    }
    for (const [what, value] of Object.entries(NOT_HERS)) {
      expect({ what, leaked: text.includes(value) }).toEqual({ what, leaked: false });
    }
    // The co-player's name is in her own bell, as it was on her screen, and
    // nowhere else in the file.
    const elsewhere = JSON.stringify({
      ...json,
      notifications: { ...(json.notifications as object), bell: [] },
    });
    expect(text).toContain('Петър Съиграч');
    expect(elsewhere).not.toContain('Петър Съиграч');
    const keys = keysOf(json);
    for (const column of EXPORT_EXCLUDED_COLUMNS) {
      expect({ column, present: keys.has(column) }).toEqual({ column, present: false });
    }
  });

  it('a club account gets its holder’s own data, not the club’s', async () => {
    const owner = await signInAs(db, { userId: club.userId, memberships: [] });
    const { res, json } = await download(owner);
    expect(res.status).toBe(200);
    expect(json.profile).toMatchObject({ accountKind: 'CLUB', email: club.ownerEmail });
    expect(json.memberships).toEqual([expect.objectContaining({ role: 'OWNER' })]);
    // The club's diary is the club's: none of its bookings are the owner's.
    expect(json.bookings).toEqual({ asBooker: [], asPlayer: [] });
    expect(json.weeklySeries).toEqual([]);
    expect(json.credit).toEqual({ balances: [], ledger: [] });
  });

  it('nobody signed in, or an account since deleted: 401', async () => {
    const anonymous = await exportRoute(
      new NextRequest('http://localhost:3000/api/v1/me/export'),
      {},
    );
    expect(anonymous.status).toBe(401);

    const fresh = await signInAs(db, {
      userId: await seedPlayer(db, club.tenantId),
      memberships: [],
    });
    const gone = await deleteMe(
      new NextRequest('http://localhost:3000/api/v1/me', {
        method: 'DELETE',
        headers: { authorization: `Bearer ${fresh.bearer}` },
      }),
      {},
    );
    expect(gone.status).toBe(204);
    const after = await exportRoute(
      new NextRequest('http://localhost:3000/api/v1/me/export', {
        headers: { authorization: `Bearer ${fresh.bearer}` },
      }),
      {},
    );
    expect(after.status).toBe(401);
  });

  describe('rate limits (#370)', () => {
    const previous = process.env.RATE_LIMIT_ENABLED;
    beforeEach(() => {
      process.env.RATE_LIMIT_ENABLED = '1';
    });
    afterEach(async () => {
      if (previous === undefined) delete process.env.RATE_LIMIT_ENABLED;
      else process.env.RATE_LIMIT_ENABLED = previous;
      await clearAllRateLimits();
    });

    it('the export answers 429 after 10 an hour', async () => {
      for (let i = 0; i < 10; i++) expect((await download(player)).res.status).toBe(200);
      const res = await exportRoute(
        new NextRequest('http://localhost:3000/api/v1/me/export', {
          headers: { authorization: `Bearer ${player.bearer}` },
        }),
        {},
      );
      expect(res.status).toBe(429);
      expect(res.headers.get('retry-after')).toBeTruthy();
    });

    it('the deletion answers 429 after 5 an hour', async () => {
      // An upcoming booking keeps every attempt a refusal, so the account
      // survives to be counted.
      await asAppSuperuser(db, (tx) =>
        tx.booking.create({
          data: {
            tenantId: club.tenantId,
            resourceId: court.resourceId,
            startTs: new Date(Date.now() + 5 * DAY),
            endTs: new Date(Date.now() + 5 * DAY + HOUR),
            bookedByUserId: player.userId,
            totalCents: 2400,
            status: 'CONFIRMED',
            idempotencyKey: `limit-${Math.random()}`,
          },
        }),
      );
      const attempt = () =>
        deleteMe(
          new NextRequest('http://localhost:3000/api/v1/me', {
            method: 'DELETE',
            headers: { authorization: `Bearer ${player.bearer}` },
          }),
          {},
        );
      for (let i = 0; i < 5; i++) expect((await attempt()).status).toBe(409);
      expect((await attempt()).status).toBe(429);
    });
  });
});
