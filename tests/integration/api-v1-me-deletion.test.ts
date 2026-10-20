import { NextRequest } from 'next/server';

import { GET as getStanding } from '@/app/api/v1/me/deletion/route';

import { seedPlayer, signInAs, type TestIdentity } from '../helpers/auth';
import { prismaTestClient, seedTenant, seedVenue, type SeededTenant } from '../helpers/db';
import { asAppSuperuser } from '../helpers/rls';

/**
 * GET /api/v1/me/deletion (#628): what `DELETE /me` would answer, read
 * before asking, from the same standing the web's section is drawn from.
 */
const db = prismaTestClient();
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

interface Standing {
  kind: string;
  credit: Array<{ club: string; amountCents: number; currency: string }>;
  blocked: null | {
    total: number;
    lessons: number;
    tournaments: number;
    bookings: Array<Record<string, string>>;
  };
}

async function read(who: TestIdentity | null) {
  const res = await getStanding(
    new NextRequest('http://localhost:3000/api/v1/me/deletion', {
      headers: who ? { authorization: `Bearer ${who.bearer}` } : {},
    }),
    {},
  );
  return { res, body: (await res.json()) as { data: Standing; error?: { code: string } } };
}

describe('GET /api/v1/me/deletion (#628)', () => {
  let club: SeededTenant;
  let court: { venueId: string; venueSlug: string; resourceId: string };
  let player: TestIdentity;

  beforeEach(async () => {
    club = await seedTenant({ name: 'Клуб Алфа' });
    court = await seedVenue(club.tenantId, { name: 'Алфа Кортове' });
    player = await signInAs(db, { userId: await seedPlayer(db, club.tenantId), memberships: [] });
  });

  it('401s signed out', async () => {
    const { res, body } = await read(null);
    expect(res.status).toBe(401);
    expect(body.error?.code).toBe('UNAUTHORIZED');
  });

  it('allowed, with the credit it loses in euros', async () => {
    await asAppSuperuser(db, (tx) =>
      tx.creditLedgerEntry.create({
        data: {
          tenantId: club.tenantId,
          userId: player.userId,
          deltaCents: 1250,
          reason: 'ADMIN_ADJUST',
          balanceAfterCents: 1250,
        },
      }),
    );
    const { res, body } = await read(player);
    expect(res.status).toBe(200);
    expect(body.data).toEqual({
      kind: 'allowed',
      credit: [{ club: 'Клуб Алфа', amountCents: 1250, currency: 'EUR' }],
      blocked: null,
    });
  });

  it('blocked by an upcoming booking, with what frees it, on the API clock', async () => {
    const start = new Date(Date.now() + 3 * DAY);
    start.setUTCMilliseconds(0);
    const booked = await asAppSuperuser(db, (tx) =>
      tx.booking.create({
        data: {
          tenantId: club.tenantId,
          resourceId: court.resourceId,
          bookedByUserId: player.userId,
          startTs: start,
          endTs: new Date(start.getTime() + HOUR),
          totalCents: 2400,
          status: 'CONFIRMED',
          idempotencyKey: `k-${Math.random()}`,
        },
        select: { id: true },
      }),
    );
    const { res, body } = await read(player);
    expect(res.status).toBe(200);
    expect(body.data.kind).toBe('blocked');
    expect(body.data.blocked).toMatchObject({ total: 1, lessons: 0, tournaments: 0 });
    const row = body.data.blocked!.bookings[0]!;
    expect(row).toMatchObject({
      bookingId: booked.id,
      venueName: 'Алфа Кортове',
      role: 'BOOKER',
      cure: 'cancel',
      startTs: start.toISOString().replace('.000Z', 'Z'),
    });
    // Every instant without fractional seconds, as the rest of v1 writes them.
    for (const key of ['startTs', 'endTs', 'cancellableUntil', 'deletableFrom']) {
      expect(row[key]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    }
  });

  it('a club account: deleted by the platform, nothing more to show', async () => {
    const owner = await signInAs(db, { userId: club.userId, memberships: [] });
    const { res, body } = await read(owner);
    expect(res.status).toBe(200);
    expect(body.data).toEqual({ kind: 'club', credit: [], blocked: null });
  });
});
