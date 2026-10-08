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
 * else is: no secret, no token, nobody else's email, phone or name.
 */
const db = prismaTestClient();
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const SECRETS = {
  passwordHash: '$2a$04$exportTestHashThatMustNeverLeave', // pragma: allowlist secret
  mfaSecret: 'v1:export-test-envelope-must-never-leave', // pragma: allowlist secret
  sessionToken: 'session-token-hash-must-never-leave',
  refreshToken: 'refresh-token-hash-must-never-leave',
  p256dh: 'push-key-must-never-leave',
  pushAuth: 'push-auth-must-never-leave',
  deviceToken: 'apns-device-token-must-never-leave',
  linkHash: 'invite-link-hash-must-never-leave',
  recoveryCode: 'recovery-code-hash-must-never-leave',
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
          avatarUrl: 'https://lh3.googleusercontent.com/a/maria',
          passwordHash: SECRETS.passwordHash,
          mfaSecret: SECRETS.mfaSecret,
          emailBookingReminders: false,
        },
      });
      await tx.user.update({
        where: { id: otherId },
        data: { name: 'Петър Съиграч', phone: '+359888999000' },
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
      await tx.mfaRecoveryCode.create({ data: { userId, codeHash: SECRETS.recoveryCode } });
      await tx.pushSubscription.create({
        data: {
          userId,
          endpoint: 'https://push.test/endpoint',
          p256dh: SECRETS.p256dh,
          auth: SECRETS.pushAuth,
        },
      });
      await tx.deviceToken.create({
        data: { userId, deviceToken: SECRETS.deviceToken, bundleId: 'bg.playerz' },
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
          idempotencyKey: `export-${Math.random()}`,
        },
      });
      mineId = mine.id;
      const theirs = await tx.booking.create({
        data: {
          tenantId: club.tenantId,
          resourceId: court.resourceId,
          startTs: new Date(past.getTime() + 2 * HOUR),
          endTs: new Date(past.getTime() + 3 * HOUR),
          bookedByUserId: otherId,
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
          guestName: 'Гост Гостев',
          guestEmail: 'guest@example.bg',
          position: 3,
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
    const { json } = await download(player);
    expect(Object.keys(json)).toEqual([
      'format',
      'version',
      'exportedAt',
      'profile',
      'signIn',
      'memberships',
      'bookings',
      'reviews',
      'notificationSettings',
      'inviteLinks',
    ]);
    expect(json.profile).toMatchObject({
      id: player.userId,
      name: 'Мария Иванова',
      phone: '+359888000111',
      avatarUrl: 'https://lh3.googleusercontent.com/a/maria',
      accountKind: 'PLAYER',
      sports: [{ sport: 'TENNIS', level: 3 }],
      playerProfile: { displayName: 'Мария', bio: 'Обичам тенис' },
    });
    expect(json.signIn).toMatchObject({ providerAccounts: [], twoStepVerification: false });
    expect(json.memberships).toEqual([
      expect.objectContaining({ club: 'Клуб Алфа', role: 'PLAYER', status: 'ACTIVE' }),
    ]);
    const bookings = json.bookings as { asBooker: unknown[]; asPlayer: unknown[] };
    expect(bookings.asBooker).toEqual([
      expect.objectContaining({
        id: mineId,
        venue: 'Алфа Кортове',
        court: 'Court 1',
        price: { cents: 3000, currency: 'EUR' },
        status: 'COMPLETED',
        addedPlayers: 0,
      }),
    ]);
    expect(bookings.asPlayer).toEqual([
      expect.objectContaining({ id: theirsId, venue: 'Алфа Кортове', addedPlayers: 2 }),
    ]);
    expect(json.reviews).toEqual([
      expect.objectContaining({ venue: 'Алфа Кортове', rating: 4, text: 'Хубави кортове' }),
    ]);
    expect(json.notificationSettings).toEqual({
      email: { bookingConfirmations: true, bookingReminders: false, clubChanges: true },
    });
    expect(json.inviteLinks).toEqual([expect.objectContaining({ bookingId: mineId })]);
  });

  it('carries no secret, no token, and nobody else’s name, email or phone', async () => {
    const { text, json } = await download(player);
    for (const [what, value] of Object.entries(SECRETS)) {
      expect({ what, leaked: text.includes(value) }).toEqual({ what, leaked: false });
    }
    for (const other of [
      'Петър Съиграч',
      '+359888999000',
      'coplayer-',
      'Гост Гостев',
      'guest@example.bg',
    ]) {
      expect({ other, leaked: text.includes(other) }).toEqual({ other, leaked: false });
    }
    // No IP address or user agent either: sessions are not part of the export.
    expect(text).not.toContain('198.51.100.4');
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
