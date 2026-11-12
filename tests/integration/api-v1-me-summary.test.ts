import { NextRequest } from 'next/server';

import { GET as listRoute } from '@/app/api/v1/me/bookings/route';
import { GET as notificationsRoute } from '@/app/api/v1/me/notifications/route';
import { GET as summaryRoute } from '@/app/api/v1/me/summary/route';

import { seedPlayer, signInAs, type TestIdentity } from '../helpers/auth';
import { prismaTestClient, seedTenant, seedVenue, type SeededTenant } from '../helpers/db';
import { asAppSuperuser } from '../helpers/rls';

/**
 * What the restyled phone reads in one go (#668): the «Профил» tiles' counts
 * and «Начало»'s next booking, the bell's groups, and the club's logo and
 * city on a booking card.
 */
const db = prismaTestClient();
const HOUR = 3_600_000;

const get = async <T>(
  route: (req: NextRequest, ctx: { params: Promise<object> }) => Promise<Response>,
  who: TestIdentity | null,
  path: string,
) => {
  const res = await route(
    new NextRequest(`http://localhost:3000/api/v1${path}`, {
      headers: who ? { authorization: `Bearer ${who.bearer}` } : {},
    }),
    { params: Promise.resolve({}) },
  );
  return { res, body: (await res.json()) as { data: T; error?: { details?: { field?: string } } } };
};

interface Summary {
  upcomingBookings: number;
  upcomingGames: number;
  pendingGameRequests: number;
  unreadNotifications: number;
  nextBooking: { id: string; clubLogoUrl: string | null; venue: { city: string } } | null;
}

describe('the phone home and profile reads (#668)', () => {
  let club: SeededTenant;
  let court: { venueId: string; resourceId: string };
  let player: TestIdentity;
  let rival: TestIdentity;

  const book = (who: TestIdentity, startsInHours: number, status: 'CONFIRMED' | 'CANCELLED' = 'CONFIRMED') => {
    const start = new Date(Date.now() + startsInHours * HOUR);
    return asAppSuperuser(db, (tx) =>
      tx.booking.create({
        data: {
          tenantId: club.tenantId,
          resourceId: court.resourceId,
          startTs: start,
          endTs: new Date(start.getTime() + HOUR),
          bookedByUserId: who.userId,
          totalCents: 2400,
          status,
          idempotencyKey: `k-${Math.random()}`,
        },
        select: { id: true },
      }),
    ).then((b) => b.id);
  };

  const notify = (userId: string, kind: string, read = false) =>
    asAppSuperuser(db, (tx) =>
      tx.notification.create({
        data: {
          userId,
          kind: kind as never,
          title: 't',
          body: 'b',
          readAt: read ? new Date() : null,
        },
      }),
    );

  beforeEach(async () => {
    club = await seedTenant({});
    court = await seedVenue(club.tenantId, { name: 'Алфа Кортове' });
    await asAppSuperuser(db, (tx) =>
      tx.venueOrg.update({
        where: { id: club.tenantId },
        data: { logoUrl: 'https://cdn.test/l.webp' },
      }),
    );
    const sign = async (label: string) => {
      const id = await seedPlayer(db, club.tenantId, label);
      return signInAs(db, {
        userId: id,
        memberships: [{ tenantId: club.tenantId, tenantSlug: club.tenantSlug, role: 'PLAYER' }],
      });
    };
    player = await sign('player');
    rival = await sign('rival');
  });

  it('401s signed out', async () => {
    expect((await get(summaryRoute, null, '/me/summary')).res.status).toBe(401);
  });

  it('counts what the lists hold, and names the next booking with its club', async () => {
    const later = await book(player, 72);
    const soon = await book(player, 24);
    await book(player, 30, 'CANCELLED');
    await book(player, -24);
    await book(rival, 5);
    await asAppSuperuser(db, (tx) =>
      tx.openGame.create({
        data: { tenantId: club.tenantId, bookingId: later, spotsWanted: 1 },
      }),
    );
    await notify(player.userId, 'BOOKING_CONFIRMED');
    await notify(player.userId, 'OPEN_PLAY_ACCEPTED');
    await notify(player.userId, 'MESSAGE_RECEIVED', true);

    const { res, body } = await get<Summary>(summaryRoute, player, '/me/summary');
    expect(res.status).toBe(200);
    expect(body.data).toMatchObject({
      upcomingBookings: 2,
      upcomingGames: 1,
      pendingGameRequests: 0,
      unreadNotifications: 2,
      nextBooking: {
        id: soon,
        clubLogoUrl: 'https://cdn.test/l.webp',
        venue: { city: expect.any(String) },
      },
    });

    // The tile matches the list it opens.
    const upcoming = await get<{ items: unknown[] }>(
      listRoute,
      player,
      '/me/bookings?when=upcoming',
    );
    expect(upcoming.body.data.items).toHaveLength(2);
  });

  it('the bell: a group per notification, a filter, and unread per group', async () => {
    await notify(player.userId, 'BOOKING_CONFIRMED');
    await notify(player.userId, 'BOOKING_REMINDER', true);
    await notify(player.userId, 'OPEN_PLAY_ACCEPTED');
    await notify(player.userId, 'TOURNAMENT_ROUND');

    type Page = {
      items: Array<{ kind: string; category: string }>;
      unreadCount: number;
      unreadByCategory: Record<string, number>;
    };
    const all = await get<Page>(notificationsRoute, player, '/me/notifications');
    expect(all.body.data.items.map((n) => n.category).sort()).toEqual([
      'bookings',
      'bookings',
      'games',
      'tournaments',
    ]);
    expect(all.body.data.unreadByCategory).toEqual({
      bookings: 1,
      games: 1,
      messages: 0,
      lessons: 0,
      tournaments: 1,
      other: 0,
    });
    expect(all.body.data.unreadCount).toBe(3);

    const bookings = await get<Page>(
      notificationsRoute,
      player,
      '/me/notifications?category=bookings',
    );
    expect(bookings.body.data.items.map((n) => n.kind).sort()).toEqual([
      'BOOKING_CONFIRMED',
      'BOOKING_REMINDER',
    ]);

    const bad = await get<Page>(notificationsRoute, player, '/me/notifications?category=nope');
    expect(bad.res.status).toBe(400);
    expect(bad.body.error?.details?.field).toBe('category');
  });
});
