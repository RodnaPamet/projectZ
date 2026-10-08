import { NextRequest } from 'next/server';
import { decode } from 'next-auth/jwt';

import { loadDiaryDay } from '@/app/(app)/t/[slug]/admin/calendar/diary-day';
import { DELETE as deleteMe, GET as getMeRoute } from '@/app/api/v1/me/route';
import { listPlayers } from '@/app-layer/repositories/player';
import { deleteAccount, deletionStanding } from '@/app-layer/usecases/account-deletion';
import { loadClubStatement } from '@/app-layer/usecases/club-fees';
import { getMyBooking } from '@/app-layer/usecases/my-bookings';
import { SessionRevokedError, authOptions } from '@/auth';
import { tombstoneEmail } from '@/lib/account/deleted-user';
import { checkSession } from '@/lib/auth/sessions';
import { statementMonthOf } from '@/lib/billing/club-fee';
import { runAsSuperuser } from '@/lib/db/rls-middleware';

import { seedPlayer, signInAs, type TestIdentity } from '../helpers/auth';
import { prismaTestClient, seedTenant, seedVenue, type SeededTenant } from '../helpers/db';
import { asAppSuperuser, asAppUser } from '../helpers/rls';

/**
 * Deleting an account (#370), against a real database.
 *
 * The plan (src/lib/account/deletion-plan.ts) says what happens to every table;
 * this seeds a person into every live one, deletes them through the route, and
 * checks each row did what the plan says: deleted, anonymised, or kept. Then
 * the rules around it: who may, when, that every session dies at once, that a
 * new sign-in makes a new account, that the club still shows the bookings as
 * "Изтрит потребител", and that nothing can be written for the account again,
 * even by a writer racing the deletion.
 */
const db = prismaTestClient();
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const auth = (who: TestIdentity) => ({ authorization: `Bearer ${who.bearer}` });

async function callDelete(who: TestIdentity | null) {
  const res = await deleteMe(
    new NextRequest('http://localhost:3000/api/v1/me', {
      method: 'DELETE',
      headers: who ? auth(who) : {},
    }),
    {},
  );
  const text = await res.text();
  return {
    res,
    body: text ? (JSON.parse(text) as { error?: { code: string; details?: unknown } }) : null,
  };
}

async function callGetMe(who: TestIdentity) {
  return getMeRoute(new NextRequest('http://localhost:3000/api/v1/me', { headers: auth(who) }), {});
}

const tokenOf = async (who: TestIdentity) =>
  (await decode({ token: who.bearer, secret: process.env.NEXTAUTH_SECRET! }))!;

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
      select: { id: true, startTs: true },
    }),
  );
}

describe('who may delete, and when (#370)', () => {
  let club: SeededTenant;
  let court: { venueId: string; venueSlug: string; resourceId: string };
  let player: TestIdentity;

  beforeEach(async () => {
    club = await seedTenant({});
    court = await seedVenue(club.tenantId, { name: 'Алфа Кортове' });
    player = await signInAs(db, { userId: await seedPlayer(db, club.tenantId), memberships: [] });
  });

  it('nobody signed in: 401', async () => {
    const { res } = await callDelete(null);
    expect(res.status).toBe(401);
  });

  it('a club account is refused with 403 CLUB_ACCOUNT_DELETION_BY_REQUEST, and nothing changes', async () => {
    const owner = await signInAs(db, { userId: club.userId, memberships: [] });
    const { res, body } = await callDelete(owner);
    expect(res.status).toBe(403);
    expect(body?.error?.code).toBe('CLUB_ACCOUNT_DELETION_BY_REQUEST');

    const row = await asAppSuperuser(db, (tx) =>
      tx.user.findUniqueOrThrow({ where: { id: club.userId } }),
    );
    expect(row.deletedAt).toBeNull();
    expect(row.email).toBe(club.ownerEmail);
    expect((await callGetMe(owner)).status).toBe(200);
  });

  it('an upcoming booking it made blocks it (409 UPCOMING_BOOKINGS); cancelling frees it', async () => {
    const soon = await booking(club.tenantId, court.resourceId, new Date(Date.now() + 3 * DAY), {
      bookedByUserId: player.userId,
    });

    const refused = await callDelete(player);
    expect(refused.res.status).toBe(409);
    expect(refused.body?.error?.code).toBe('UPCOMING_BOOKINGS');
    expect(refused.body?.error?.details).toMatchObject({
      total: 1,
      bookings: [{ bookingId: soon.id, role: 'BOOKER', cure: 'cancel' }],
    });
    // Nothing was written: the account still answers.
    expect((await callGetMe(player)).status).toBe(200);

    await asAppSuperuser(db, (tx) =>
      tx.booking.update({
        where: { id: soon.id },
        data: { status: 'CANCELLED', cancelledAt: new Date() },
      }),
    );
    const done = await callDelete(player);
    expect(done.res.status).toBe(204);
  });

  it('one it was added to blocks it too, until it leaves', async () => {
    const otherId = await seedPlayer(db, club.tenantId, 'other');
    const theirs = await booking(club.tenantId, court.resourceId, new Date(Date.now() + 2 * DAY), {
      bookedByUserId: otherId,
    });
    const place = await asAppSuperuser(db, (tx) =>
      tx.bookingParticipant.create({
        data: { tenantId: club.tenantId, bookingId: theirs.id, userId: player.userId, position: 2 },
      }),
    );

    const refused = await callDelete(player);
    expect(refused.res.status).toBe(409);
    expect(refused.body?.error?.details).toMatchObject({
      bookings: [{ bookingId: theirs.id, role: 'PARTICIPANT', cure: 'leave' }],
    });

    await asAppSuperuser(db, (tx) => tx.bookingParticipant.delete({ where: { id: place.id } }));
    expect((await callDelete(player)).res.status).toBe(204);
  });

  it('inside the club’s cutoff the cure is to wait: deletion becomes possible at its end', async () => {
    const start = new Date(Date.now() + 2 * HOUR);
    const late = await booking(club.tenantId, court.resourceId, start, {
      bookedByUserId: player.userId,
    });
    const standing = await runAsSuperuser((tx) => deletionStanding(tx, player.userId));
    expect(standing).toMatchObject({
      kind: 'blocked',
      total: 1,
      bookings: [
        {
          bookingId: late.id,
          cure: 'wait',
          deletableFrom: new Date(start.getTime() + HOUR),
        },
      ],
    });
  });

  it('a booking that has been played, or is over, does not block it', async () => {
    await booking(club.tenantId, court.resourceId, new Date(Date.now() - 3 * HOUR), {
      bookedByUserId: player.userId,
      status: 'COMPLETED',
    });
    // Over but not yet swept to COMPLETED: not upcoming either (Минали).
    await booking(club.tenantId, court.resourceId, new Date(Date.now() - 2 * HOUR), {
      bookedByUserId: player.userId,
    });
    expect(await runAsSuperuser((tx) => deletionStanding(tx, player.userId))).toEqual({
      kind: 'allowed',
    });
    expect((await callDelete(player)).res.status).toBe(204);
  });
});

describe('what a deletion does to every table (#370, deletion-plan.ts)', () => {
  let club: SeededTenant;
  let court: { venueId: string; venueSlug: string; resourceId: string };
  let player: TestIdentity;
  let otherId: string;
  let email: string;
  const ids: Record<string, string> = {};

  beforeEach(async () => {
    club = await seedTenant({});
    court = await seedVenue(club.tenantId, { name: 'Алфа Кортове' });
    const userId = await seedPlayer(db, club.tenantId, 'leaving');
    otherId = await seedPlayer(db, club.tenantId, 'staying');
    const granterId = await seedPlayer(db, club.tenantId, 'granter');
    player = await signInAs(db, { userId, memberships: [] });

    const past = new Date(Date.now() - 5 * DAY);
    const mine = await booking(club.tenantId, court.resourceId, past, {
      bookedByUserId: userId,
      status: 'COMPLETED',
      channel: 'DESK',
      guestName: 'Иван Петров',
      guestPhone: '+359888123456',
      notes: 'звънец 4471',
    });
    const cancelled = await booking(
      club.tenantId,
      court.resourceId,
      new Date(past.getTime() - DAY),
      {
        bookedByUserId: userId,
        status: 'CANCELLED',
        cancelledAt: past,
        cancellationReasonJson: { reason: 'болен съм', quote: { refundCents: 0 } },
      },
    );
    const theirs = await booking(
      club.tenantId,
      court.resourceId,
      new Date(past.getTime() + 2 * HOUR),
      {
        bookedByUserId: otherId,
        status: 'COMPLETED',
      },
    );
    ids.mine = mine.id;
    ids.cancelled = cancelled.id;
    ids.theirs = theirs.id;
    const second = await seedTenant({});

    await asAppSuperuser(db, async (tx) => {
      const u = await tx.user.update({
        where: { id: userId },
        data: {
          name: 'Иван Петров',
          phone: '+359888123456',
          avatarUrl: 'https://lh3.googleusercontent.com/a/leaving',
          emailVerified: new Date(),
          mfaSecret: 'v1:not-a-real-envelope', // pragma: allowlist secret
          mfaEnabledAt: new Date(),
        },
        select: { email: true },
      });
      email = u.email;

      await tx.playerProfile.create({ data: { userId, displayName: 'Иван', bio: 'Играя падел' } });
      await tx.playerSportLevel.create({ data: { userId, sport: 'PADEL', level: 4 } });
      await tx.userSession.create({
        data: {
          userId,
          tokenHash: `native-${Math.random()}`,
          expiresAt: new Date(Date.now() + DAY),
          ipAddress: '203.0.113.7',
          userAgent: 'playerz-ios/1.0',
        },
      });
      await tx.passwordResetToken.create({
        data: {
          userId,
          tokenHash: `reset-${Math.random()}`,
          expiresAt: new Date(Date.now() + HOUR),
        },
      });
      await tx.mfaRecoveryCode.create({ data: { userId, codeHash: 'recovery-hash' } });
      await tx.accountSecurityEvent.create({
        data: {
          userId,
          action: 'MFA_STEP_UP_SUCCEEDED',
          ipAddress: '203.0.113.7',
          userAgent: 'Safari',
        },
      });
      await tx.$executeRawUnsafe(
        `INSERT INTO platform_admin_grant (id,"userId","grantedByUserId",reason,capabilities,"expiresAt")
         VALUES ($1,$2,$3,'moderation rota #370 test','{REVIEW_MODERATE}'::"PlatformCapability"[], now() + interval '1 day')`,
        `cgrant${Math.random().toString(36).slice(2, 14)}`,
        userId,
        granterId,
      );

      await tx.tenantMembership.create({
        data: { tenantId: second.tenantId, userId, role: 'PLAYER', status: 'ACTIVE' },
      });
      await tx.invite.create({
        data: {
          tenantId: second.tenantId,
          email: u.email,
          tokenHash: `invite-${Math.random()}`,
          expiresAt: new Date(Date.now() + DAY),
          role: 'STAFF',
        },
      });
      await tx.deviceToken.create({
        data: { userId, deviceToken: 'abc123', bundleId: 'bg.playerz' },
      });
      await tx.pushSubscription.create({
        data: { userId, endpoint: `https://push.test/${Math.random()}`, p256dh: 'k', auth: 'a' },
      });
      await tx.notification.create({
        data: { userId, kind: 'BOOKING_CONFIRMED', title: 'Потвърдена', body: 'Алфа Кортове' },
      });
      await tx.emailOutbox.create({
        data: {
          userId,
          kind: 'BOOKING_CONFIRMED',
          category: 'confirmation',
          dedupeKey: `booking:${mine.id}:confirmed`,
          locale: 'bg',
          subject: 'Потвърдена резервация',
          text: 'Здравей, Иван',
        },
      });

      // The account's place on someone else's game, and that booker's bell
      // saying it joined: copy that carries its name.
      const place = await tx.bookingParticipant.create({
        data: { tenantId: club.tenantId, bookingId: theirs.id, userId, position: 2 },
      });
      ids.place = place.id;
      await tx.notification.create({
        data: {
          userId: otherId,
          kind: 'BOOKING_PLAYER_JOINED',
          title: 'Иван се присъедини',
          body: 'Алфа Кортове',
          refType: 'booking',
          refId: theirs.id,
          dedupeKey: `booking:${theirs.id}:joined:${place.id}`,
        },
      });
      await tx.notification.create({
        data: {
          userId: otherId,
          kind: 'BOOKING_CONFIRMED',
          title: 'Потвърдена',
          body: 'Алфа Кортове',
          refType: 'booking',
          refId: theirs.id,
          dedupeKey: `booking:${theirs.id}:confirmed`,
        },
      });

      await tx.bookingSeries.create({
        data: {
          tenantId: club.tenantId,
          resourceId: court.resourceId,
          startTime: '19:00',
          durationMinutes: 60,
          timezone: 'Europe/Sofia',
          firstDate: new Date('2026-01-06'),
          lastDate: new Date('2026-02-24'),
          customerName: 'Иван Петров',
          customerPhone: '+359888123456',
          customerUserId: userId,
          notes: 'винаги корт 1',
          idempotencyKey: `series-${Math.random()}`,
        },
      });
      await tx.bookingInviteLink.create({
        data: {
          tenantId: club.tenantId,
          bookingId: mine.id,
          tokenHash: `link-${Math.random()}`,
          createdByUserId: userId,
          expiresAt: mine.startTs,
        },
      });
      const review = await tx.review.create({
        data: {
          tenantId: club.tenantId,
          venueId: court.venueId,
          authorUserId: userId,
          rating: 5,
          body: 'Страхотни кортове',
          bookingId: mine.id,
          status: 'PUBLISHED',
        },
      });
      await tx.venue.update({
        where: { id: court.venueId },
        data: { avgRating: 5, reviewCount: 1 },
      });
      await tx.contentReport.create({
        data: {
          subjectType: 'REVIEW',
          subjectId: review.id,
          reporterUserId: userId,
          reason: 'spam',
        },
      });
      await tx.moderationCase.create({
        data: {
          subjectType: 'REVIEW',
          subjectId: review.id,
          reason: 'user_report',
          reportedByUserId: userId,
        },
      });
      await tx.playerVenueRelationship.create({
        data: { tenantId: club.tenantId, playerUserId: userId, tags: ['вип'] },
      });
      await tx.creditLedgerEntry.create({
        data: {
          tenantId: club.tenantId,
          userId,
          deltaCents: 500,
          reason: 'ADMIN_ADJUST',
          balanceAfterCents: 500,
        },
      });
      await tx.clubFeeLine.create({
        data: {
          tenantId: club.tenantId,
          bookingId: mine.id,
          kind: 'CHARGE',
          venueId: court.venueId,
          venueName: 'Алфа Кортове',
          resourceId: court.resourceId,
          courtName: 'Court 1',
          bookingStartTs: mine.startTs,
          statementMonth: statementMonthOf(mine.startTs),
          priceCents: 2400,
          feeBps: 1000,
          freePeriod: false,
          feeCents: 240,
          currency: 'EUR',
        },
      });
      await tx.xpEvent.create({
        data: { userId, type: 'BOOKING_COMPLETED', points: 10, dedupeKey: `xp-${mine.id}` },
      });
      await tx.skillRatingHistory.create({
        data: { userId, sport: 'PADEL', engine: 'OPENSKILL', mu: 25, sigma: 8.3, displayRating: 0 },
      });
      await tx.userBlock.create({ data: { blockerId: userId, blockedId: otherId } });
      await tx.wearableConnection.create({
        data: {
          userId,
          provider: 'STRAVA',
          accessTokenEnc: 'enc-a',
          refreshTokenEnc: 'enc-r',
          expiresAt: new Date(Date.now() + DAY),
          externalAthleteId: `athlete-${Math.random()}`,
        },
      });
      await tx.activity.create({
        data: { userId, source: 'MANUAL', sport: 'RUNNING', startedAt: past, durationS: 1800 },
      });
    });
  });

  it('deletes, anonymises and keeps exactly what the plan says', async () => {
    const userId = player.userId;
    const before = await asAppSuperuser(db, (tx) =>
      tx.user.findUniqueOrThrow({ where: { id: userId }, select: { sessionVersion: true } }),
    );

    const { res } = await callDelete(player);
    expect(res.status).toBe(204);

    const after = await asAppSuperuser(db, async (tx) => ({
      user: await tx.user.findUniqueOrThrow({ where: { id: userId } }),
      deleted: {
        PlayerProfile: await tx.playerProfile.count({ where: { userId } }),
        PlayerSportLevel: await tx.playerSportLevel.count({ where: { userId } }),
        UserSession: await tx.userSession.count({ where: { userId } }),
        PasswordResetToken: await tx.passwordResetToken.count({ where: { userId } }),
        MfaRecoveryCode: await tx.mfaRecoveryCode.count({ where: { userId } }),
        TenantMembership: await tx.tenantMembership.count({ where: { userId } }),
        Invite: await tx.invite.count({ where: { email } }),
        DeviceToken: await tx.deviceToken.count({ where: { userId } }),
        PushSubscription: await tx.pushSubscription.count({ where: { userId } }),
        Notification: await tx.notification.count({ where: { userId } }),
        NotificationNamingIt: await tx.notification.count({
          where: { userId: otherId, kind: 'BOOKING_PLAYER_JOINED' },
        }),
        EmailOutbox: await tx.emailOutbox.count({ where: { userId } }),
        BookingInviteLink: await tx.bookingInviteLink.count({ where: { createdByUserId: userId } }),
        Review: await tx.review.count({ where: { authorUserId: userId } }),
        ContentReport: await tx.contentReport.count({ where: { reporterUserId: userId } }),
        PlayerVenueRelationship: await tx.playerVenueRelationship.count({
          where: { playerUserId: userId },
        }),
        XpEvent: await tx.xpEvent.count({ where: { userId } }),
        SkillRatingHistory: await tx.skillRatingHistory.count({ where: { userId } }),
        UserBlock: await tx.userBlock.count({
          where: { OR: [{ blockerId: userId }, { blockedId: userId }] },
        }),
        WearableConnection: await tx.wearableConnection.count({ where: { userId } }),
        Activity: await tx.activity.count({ where: { userId } }),
      },
      securityEvent: await tx.accountSecurityEvent.findFirstOrThrow({ where: { userId } }),
      mine: await tx.booking.findUniqueOrThrow({ where: { id: ids.mine } }),
      cancelled: await tx.booking.findUniqueOrThrow({ where: { id: ids.cancelled } }),
      place: await tx.bookingParticipant.findUnique({ where: { id: ids.place } }),
      series: await tx.bookingSeries.findFirstOrThrow({ where: { customerUserId: userId } }),
      moderation: await tx.moderationCase.findFirstOrThrow({ where: { reason: 'user_report' } }),
      grant: await tx.platformAdminGrant.findFirstOrThrow({ where: { userId } }),
      venue: await tx.venue.findUniqueOrThrow({ where: { id: court.venueId } }),
      feeLines: await tx.clubFeeLine.count({ where: { bookingId: ids.mine } }),
      ledger: await tx.creditLedgerEntry.count({ where: { userId } }),
      othersBell: await tx.notification.count({
        where: { userId: otherId, kind: 'BOOKING_CONFIRMED' },
      }),
    }));

    // ── delete ──
    for (const [table, n] of Object.entries(after.deleted)) {
      expect({ table, n }).toEqual({ table, n: 0 });
    }

    // ── the tombstone ──
    expect(after.user).toMatchObject({
      email: tombstoneEmail(userId),
      name: null,
      phone: null,
      avatarUrl: null,
      passwordHash: null,
      emailVerified: null,
      mfaSecret: null,
      mfaEnabledAt: null,
      emailBookingConfirmations: false,
      emailBookingReminders: false,
      emailClubChanges: false,
      accountKind: 'PLAYER',
      sessionVersion: before.sessionVersion + 1,
    });
    expect(after.user.deletedAt).toBeInstanceOf(Date);

    // ── anonymise ──
    expect(after.securityEvent).toMatchObject({
      action: 'MFA_STEP_UP_SUCCEEDED',
      ipAddress: null,
      userAgent: null,
    });
    expect(after.mine).toMatchObject({
      bookedByUserId: userId,
      status: 'COMPLETED',
      guestName: null,
      guestPhone: null,
      guestEmail: null,
      notes: null,
      totalCents: 2400,
    });
    expect(after.cancelled.cancellationReasonJson).toEqual({
      reason: null,
      quote: { refundCents: 0 },
    });
    expect(after.series).toMatchObject({ customerName: '', customerPhone: '', notes: null });
    expect(after.moderation.reportedByUserId).toBeNull();
    expect(after.grant.revokedAt).toBeInstanceOf(Date);
    expect(after.grant.revokedByUserId).toBe(userId);

    // ── keep ──
    expect(after.place).toMatchObject({ userId, bookingId: ids.theirs });
    expect(after.feeLines).toBe(1);
    expect(after.ledger).toBe(1);
    expect(after.othersBell).toBe(1);
    // The rating its review moved is recomputed: no review left, no rating.
    expect(after.venue.reviewCount).toBe(0);
    expect(Number(after.venue.avgRating)).toBe(0);
  });

  it('every session is dead on its next request: the API, checkSession and next-auth', async () => {
    const token = await tokenOf(player);
    expect((await callGetMe(player)).status).toBe(200);

    expect((await callDelete(player)).res.status).toBe(204);

    expect((await callGetMe(player)).status).toBe(401);
    expect(
      await checkSession({
        userSessionId: token.userSessionId as string,
        sessionVersion: token.sessionVersion as number,
        sessionSecret: token.sessionSecret as string,
      }),
    ).toEqual({ usable: false, reason: 'unknown' });

    // `/api/auth/session` runs the jwt callback: it now signs the token out,
    // which next-auth turns into an expired cookie and an empty session.
    await expect(
      authOptions.callbacks!.jwt!({ token, user: undefined as never, account: null } as never),
    ).rejects.toBeInstanceOf(SessionRevokedError);
  });

  it('the response expires the session cookie it was sent with', async () => {
    const res = await deleteMe(
      new NextRequest('http://localhost:3000/api/v1/me', {
        method: 'DELETE',
        headers: {
          cookie: `next-auth.session-token=${player.bearer}; NEXT_LOCALE=bg`,
          'sec-fetch-site': 'same-origin',
        },
      }),
      {},
    );
    expect(res.status).toBe(204);
    const set = res.headers.getSetCookie();
    expect(set).toHaveLength(1);
    expect(set[0]).toMatch(/^next-auth\.session-token=;.*Max-Age=0/i);
    // Only the session: the language stays.
    expect(set.some((c) => c.startsWith('NEXT_LOCALE='))).toBe(false);
  });

  it('signing in again with the same address makes a NEW account; the old one stays a tombstone', async () => {
    expect((await callDelete(player)).res.status).toBe(204);

    const user = { id: 'google-sub-1', email, name: 'Иван Наново', image: null } as {
      id: string;
      email: string;
      name: string;
      image: null;
    };
    const ok = await authOptions.callbacks!.signIn!({
      user,
      account: { type: 'oauth', provider: 'google', providerAccountId: 'google-sub-1' },
      profile: { email_verified: true },
    } as never);
    expect(ok).toBe(true);
    expect(user.id).not.toBe(player.userId);

    const rows = await asAppSuperuser(db, (tx) =>
      tx.user.findMany({
        where: { OR: [{ id: player.userId }, { email }] },
        select: { id: true, email: true, name: true, deletedAt: true, accountKind: true },
        take: 5,
      }),
    );
    const fresh = rows.find((r) => r.email === email)!;
    expect(fresh).toMatchObject({
      id: user.id,
      name: 'Иван Наново',
      deletedAt: null,
      accountKind: null,
    });
    expect(rows.find((r) => r.id === player.userId)).toMatchObject({
      email: tombstoneEmail(player.userId),
      name: null,
    });
    // Nothing of the old account came with it.
    const carried = await asAppSuperuser(db, (tx) =>
      tx.booking.count({ where: { bookedByUserId: user.id } }),
    );
    expect(carried).toBe(0);
  });

  it('the tombstone is final, and nothing new is written for it', async () => {
    expect((await callDelete(player)).res.status).toBe(204);

    await expect(
      asAppSuperuser(db, (tx) =>
        tx.user.update({ where: { id: player.userId }, data: { name: 'Back' } }),
      ),
    ).rejects.toThrow(/app_user_tombstone_final/);
    await expect(
      booking(club.tenantId, court.resourceId, new Date(Date.now() + DAY), {
        bookedByUserId: player.userId,
      }),
    ).rejects.toThrow(/account_deleted/);
    await expect(
      asAppSuperuser(db, (tx) =>
        tx.tenantMembership.create({
          data: {
            tenantId: club.tenantId,
            userId: player.userId,
            role: 'PLAYER',
            status: 'ACTIVE',
          },
        }),
      ),
    ).rejects.toThrow(/account_deleted/);
    // A second deletion finds no account.
    expect((await callDelete(player)).res.status).toBe(401);
  });

  it('the club still shows the bookings, as "Изтрит потребител", and its statement is unchanged', async () => {
    const month = statementMonthOf(new Date(Date.now() - 5 * DAY));
    const statementBefore = await asAppUser(db, club.tenantId, (tx) =>
      loadClubStatement(tx, club.tenantId, month),
    );

    expect((await callDelete(player)).res.status).toBe(204);

    const players = await asAppUser(db, club.tenantId, (tx) => listPlayers(tx, club.tenantId));
    expect(players.find((p) => p.playerUserId === player.userId)).toMatchObject({
      deleted: true,
      name: null,
      email: '',
      tags: [],
    });

    const day = new Date(Date.now() - 5 * DAY).toLocaleDateString('en-CA', {
      timeZone: 'Europe/Sofia',
    });
    const diary = await loadDiaryDay(club.tenantId, day, {
      locale: 'bg',
      labels: { unknownPlayer: '?', guest: 'Гост', deletedUser: 'Изтрит потребител' },
    });
    expect(diary.bookings.find((b) => b.id === ids.mine)?.who).toBe('Изтрит потребител');

    const theirs = await getMyBooking({ userId: otherId, bookingId: ids.theirs });
    expect(theirs?.players.find((p) => !p.isBooker)).toMatchObject({
      deleted: true,
      name: null,
      avatarUrl: null,
    });

    const statementAfter = await asAppUser(db, club.tenantId, (tx) =>
      loadClubStatement(tx, club.tenantId, month),
    );
    expect(statementAfter?.totals).toEqual(statementBefore?.totals);
    expect(statementAfter?.lines.map((l) => l.bookingId)).toContain(ids.mine);
  });
});

describe('a booking racing the deletion (#370, P52)', () => {
  /** A promise and the function that resolves it. */
  function signal() {
    let fire!: () => void;
    const fired = new Promise<void>((r) => (fire = r));
    return { fire, fired };
  }

  it('a booking that commits first makes the deletion wait, then refuse', async () => {
    const club = await seedTenant({});
    const court = await seedVenue(club.tenantId);
    const userId = await seedPlayer(db, club.tenantId);

    const inserted = signal();
    const commit = signal();
    // The writer: its booking is in, its FOR KEY SHARE on the person is
    // held, and it has not committed yet.
    const writer = db.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe('SET LOCAL ROLE app_superuser');
        await tx.booking.create({
          data: {
            tenantId: club.tenantId,
            resourceId: court.resourceId,
            startTs: new Date(Date.now() + 2 * DAY),
            endTs: new Date(Date.now() + 2 * DAY + HOUR),
            bookedByUserId: userId,
            totalCents: 2400,
            status: 'CONFIRMED',
            idempotencyKey: `race-${Math.random()}`,
          },
        });
        inserted.fire();
        await commit.fired;
      },
      { timeout: 20_000 },
    );
    await inserted.fired;

    const deletion = runAsSuperuser((tx) => deleteAccount(tx, { userId, by: 'self' }));
    // The deletion is now waiting on the person's row.
    await new Promise((r) => setTimeout(r, 300));
    commit.fire();
    await writer;

    await expect(deletion).rejects.toMatchObject({ name: 'UpcomingBookingsError' });
    const row = await asAppSuperuser(db, (tx) =>
      tx.user.findUniqueOrThrow({ where: { id: userId }, select: { deletedAt: true } }),
    );
    expect(row.deletedAt).toBeNull();
  });

  it('a booking that comes second waits for the deletion, then is refused', async () => {
    const club = await seedTenant({});
    const court = await seedVenue(club.tenantId);
    const userId = await seedPlayer(db, club.tenantId);

    const locked = signal();
    const commit = signal();
    // The deletion's own first move, held open: the person locked FOR UPDATE.
    // Then the tombstone, as `deleteAccount` ends.
    const deletion = db.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe('SET LOCAL ROLE app_superuser');
        await tx.$queryRaw`SELECT id FROM app_user WHERE id = ${userId} FOR UPDATE`;
        locked.fire();
        await commit.fired;
        await tx.user.update({
          where: { id: userId },
          data: { email: tombstoneEmail(userId), name: null, deletedAt: new Date() },
        });
      },
      { timeout: 20_000 },
    );
    await locked.fired;

    const racing = booking(club.tenantId, court.resourceId, new Date(Date.now() + 2 * DAY), {
      bookedByUserId: userId,
    });
    // The writer is now waiting on the person's row.
    await new Promise((r) => setTimeout(r, 300));
    commit.fire();
    await deletion;

    await expect(racing).rejects.toThrow(/account_deleted/);
    const live = await asAppSuperuser(db, (tx) =>
      tx.booking.count({ where: { bookedByUserId: userId } }),
    );
    expect(live).toBe(0);
  });
});
