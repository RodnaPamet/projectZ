import { randomUUID } from 'node:crypto';

import { type BookingStatus, PlatformCapability } from '@prisma/client';
import { encode } from 'next-auth/jwt';
import { NextRequest } from 'next/server';

import { PUT as statusRoute } from '@/app/api/v1/platform/clubs/[clubId]/status/route';
import { POST as cancelRoute } from '@/app/api/v1/t/[slug]/bookings/[id]/cancel/route';
import {
  cancelUpcomingBookings,
  ClubStatusChangeError,
  setClubStatus,
} from '@/app-layer/usecases/club-status';
import { membershipContext } from '@/lib/auth/page-context';
import { createUserSession, newSessionSecret } from '@/lib/auth/sessions';

import { signInAs, type TestIdentity } from '../helpers/auth';
import { enrolAndStepUp } from '../helpers/mfa';
import { prismaTestClient, seedAccount, seedTenant, type SeededTenant } from '../helpers/db';
import { asAppSuperuser } from '../helpers/rls';

/**
 * Taking a club offline (#254), the owner's rules of 2026-10-13: a suspended
 * or closed club is hidden and unbookable, its upcoming bookings are cancelled
 * with notice, its staff keep read-only access, reopening brings the club back
 * but not the cancelled bookings, and CLOSED is final. TENANT_SUSPEND behind a
 * step-up, audited on both sides.
 */

const db = prismaTestClient();
const HOUR = 3_600_000;
const REASON = 'club asked to pause for renovation';

type Json = { data?: Record<string, unknown>; error?: { code: string } };
const read = async (res: Response) => ({ status: res.status, body: (await res.json()) as Json });

interface Club {
  tenant: SeededTenant;
  owner: TestIdentity;
  courtId: string;
}

async function seedClub(): Promise<Club> {
  const tenant = await seedTenant({}, db);
  const courtId = await asAppSuperuser(db, async (tx) => {
    const venue = await tx.venue.create({
      data: {
        tenantId: tenant.tenantId,
        slug: `st-${tenant.tenantId.slice(-8)}`,
        name: 'Обект Запад',
        addressLine: '2 Court St',
        city: 'Sofia',
        lat: 42.6977,
        lng: 23.3219,
        email: 'desk@club.test',
      },
    });
    const court = await tx.resource.create({
      data: {
        tenantId: tenant.tenantId,
        venueId: venue.id,
        name: 'Корт 1',
        sport: 'PADEL',
        surface: 'HARD',
        basePriceCents: 2400,
      },
    });
    return court.id;
  });
  const owner = await signInAs(db, {
    userId: tenant.userId,
    memberships: [{ tenantId: tenant.tenantId, tenantSlug: tenant.tenantSlug, role: 'OWNER' }],
  });
  return { tenant, owner, courtId };
}

/** One booking, `hours` from now (negative: in the past), an hour long. */
async function seedBooking(
  club: Club,
  hours: number,
  status: BookingStatus = 'CONFIRMED',
  bookedByUserId: string | null = null,
) {
  const start = new Date(Date.now() + hours * HOUR);
  return asAppSuperuser(db, (tx) =>
    tx.booking.create({
      data: {
        tenantId: club.tenant.tenantId,
        resourceId: club.courtId,
        startTs: start,
        endTs: new Date(start.getTime() + HOUR),
        status,
        channel: 'ONLINE',
        totalCents: 2400,
        bookedByUserId,
        idempotencyKey: `st-${randomUUID()}`,
      },
    }),
  );
}

const statusOf = (bookingId: string) =>
  asAppSuperuser(db, (tx) =>
    tx.booking.findUniqueOrThrow({ where: { id: bookingId }, select: { status: true } }),
  ).then((b) => b.status);

const clubStatus = (tenantId: string) =>
  asAppSuperuser(db, (tx) =>
    tx.venueOrg.findUniqueOrThrow({ where: { id: tenantId }, select: { status: true } }),
  ).then((c) => c.status);

describe('setClubStatus (#254)', () => {
  it('suspends, reopens and closes, writing the club its own audit row each time', async () => {
    const club = await seedClub();
    const actor = club.tenant.userId;
    const move = (to: 'ACTIVE' | 'SUSPENDED' | 'CLOSED') =>
      asAppSuperuser(db, (tx) =>
        setClubStatus(tx, {
          tenantId: club.tenant.tenantId,
          to,
          reason: REASON,
          actorUserId: actor,
        }),
      );

    await expect(move('SUSPENDED')).resolves.toMatchObject({ from: 'ACTIVE', to: 'SUSPENDED' });
    await expect(move('ACTIVE')).resolves.toMatchObject({ from: 'SUSPENDED', to: 'ACTIVE' });
    await expect(move('CLOSED')).resolves.toMatchObject({ from: 'ACTIVE', to: 'CLOSED' });

    const rows = await asAppSuperuser(db, (tx) =>
      tx.auditEntry.findMany({
        where: { tenantId: club.tenant.tenantId, action: 'CLUB_STATUS_CHANGED' },
        orderBy: { createdAt: 'asc' },
        take: 10,
      }),
    );
    expect(rows.map((r) => (r.detailsJson as { after: string }).after)).toEqual([
      'SUSPENDED',
      'ACTIVE',
      'CLOSED',
    ]);
  });

  it('refuses the same status again, and anything from CLOSED', async () => {
    const club = await seedClub();
    const move = (to: 'ACTIVE' | 'SUSPENDED' | 'CLOSED') =>
      asAppSuperuser(db, (tx) =>
        setClubStatus(tx, {
          tenantId: club.tenant.tenantId,
          to,
          reason: REASON,
          actorUserId: club.tenant.userId,
        }),
      );

    await expect(move('ACTIVE')).rejects.toBeInstanceOf(ClubStatusChangeError);
    await move('CLOSED');
    await expect(move('ACTIVE')).rejects.toBeInstanceOf(ClubStatusChangeError);
    await expect(move('SUSPENDED')).rejects.toBeInstanceOf(ClubStatusChangeError);
    expect(await clubStatus(club.tenant.tenantId)).toBe('CLOSED');
  });
});

describe('cancelUpcomingBookings (#254)', () => {
  it('cancels what has not started, leaves the rest, and tells the booker', async () => {
    const club = await seedClub();
    const playerId = await seedAccount('PLAYER', db);
    const future = await seedBooking(club, 24, 'CONFIRMED', playerId);
    const pending = await seedBooking(club, 48, 'PENDING');
    const past = await seedBooking(club, -48, 'CONFIRMED');
    const gone = await seedBooking(club, 72, 'CANCELLED');

    const result = await cancelUpcomingBookings({ tenantId: club.tenant.tenantId, reason: REASON });

    expect(result).toEqual({ cancelled: 2, failed: 0, remaining: 0 });
    expect(await statusOf(future.id)).toBe('CANCELLED');
    expect(await statusOf(pending.id)).toBe('CANCELLED');
    expect(await statusOf(past.id)).toBe('CONFIRMED');
    expect(await statusOf(gone.id)).toBe('CANCELLED');

    const bell = await asAppSuperuser(db, (tx) =>
      tx.notification.findMany({
        where: { userId: playerId, kind: 'BOOKING_CANCELLED' },
        take: 5,
      }),
    );
    expect(bell).toHaveLength(1);
  });
});

describe('PUT /api/v1/platform/clubs/{clubId}/status (#254)', () => {
  let admin: string;
  let granter: string;

  beforeEach(async () => {
    admin = await seedAccount('PLAYER', db);
    granter = await seedAccount('PLAYER', db);
  });

  async function grant(caps: PlatformCapability[]) {
    await asAppSuperuser(db, (tx) =>
      tx.$executeRawUnsafe(
        `INSERT INTO platform_admin_grant
           (id,"userId","grantedByUserId",reason,capabilities,"expiresAt")
         VALUES ($1,$2,$3,'club status rota',$4::"PlatformCapability"[], now() + interval '7 days')`,
        `cs${randomUUID().replace(/-/g, '').slice(0, 22)}`,
        admin,
        granter,
        `{${caps.join(',')}}`,
      ),
    );
  }

  async function bearerFor(userId: string) {
    const { userSessionId, sessionVersion } = await createUserSession({
      userId,
      sessionSecret: newSessionSecret(),
      expiresAt: new Date(Date.now() + HOUR),
    });
    return encode({
      secret: process.env.NEXTAUTH_SECRET!,
      maxAge: 900,
      token: { sub: userId, userSessionId, sessionVersion },
    });
  }

  const put = (bearer: string, clubId: string, body: Record<string, unknown>) =>
    statusRoute(
      new NextRequest(`http://t/api/v1/platform/clubs/${clubId}/status`, {
        method: 'PUT',
        headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ clubId }) },
    ).then(read);

  it('suspends with TENANT_SUSPEND and a step-up: hidden, bookings cancelled, audited', async () => {
    await grant([PlatformCapability.TENANT_SUSPEND]);
    const club = await seedClub();
    const booking = await seedBooking(club, 24);
    const bearer = await bearerFor(admin);
    await enrolAndStepUp(bearer);

    const res = await put(bearer, club.tenant.tenantId, { status: 'SUSPENDED', reason: REASON });

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      from: 'ACTIVE',
      to: 'SUSPENDED',
      bookings: { cancelled: 1, failed: 0, remaining: 0 },
    });
    expect(await clubStatus(club.tenant.tenantId)).toBe('SUSPENDED');
    expect(await statusOf(booking.id)).toBe('CANCELLED');
    const platformRows = await asAppSuperuser(db, (tx) =>
      tx.platformAuditEntry.findMany({ where: { action: 'PLATFORM_CLUB_SUSPENDED' }, take: 5 }),
    );
    expect(platformRows).toHaveLength(1);
  });

  it('a grant without TENANT_SUSPEND changes nothing, even stepped up', async () => {
    await grant([PlatformCapability.TENANT_READ]);
    const club = await seedClub();
    const bearer = await bearerFor(admin);
    await enrolAndStepUp(bearer);

    const res = await put(bearer, club.tenant.tenantId, { status: 'SUSPENDED', reason: REASON });

    expect(res.status).toBe(403);
    expect(res.body.error?.code).toBe('PLATFORM_CAPABILITY_REQUIRED');
    expect(await clubStatus(club.tenant.tenantId)).toBe('ACTIVE');
  });

  it('answers 409 for a change the status does not allow', async () => {
    await grant([PlatformCapability.TENANT_SUSPEND]);
    const club = await seedClub();
    const bearer = await bearerFor(admin);
    await enrolAndStepUp(bearer);

    const res = await put(bearer, club.tenant.tenantId, { status: 'ACTIVE', reason: REASON });
    expect(res.status).toBe(409);
  });
});

describe('a suspended club is read-only for its staff (#254)', () => {
  it('carries the status in the membership context', async () => {
    const club = await seedClub();
    await asAppSuperuser(db, (tx) =>
      tx.venueOrg.update({ where: { id: club.tenant.tenantId }, data: { status: 'SUSPENDED' } }),
    );
    const ctx = await membershipContext(club.tenant.userId, club.tenant.tenantSlug);
    expect(ctx.kind === 'ok' && ctx.ctx.clubStatus).toBe('SUSPENDED');
  });

  it('refuses a write through the API with CLUB_NOT_ACTIVE', async () => {
    const club = await seedClub();
    const booking = await seedBooking(club, -2 + 26);
    await asAppSuperuser(db, (tx) =>
      tx.venueOrg.update({ where: { id: club.tenant.tenantId }, data: { status: 'SUSPENDED' } }),
    );

    const res = await cancelRoute(
      new NextRequest(`http://t/api/v1/t/${club.tenant.tenantSlug}/bookings/${booking.id}/cancel`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${club.owner.bearer}`,
          'content-type': 'application/json',
        },
        body: '{}',
      }),
      { params: Promise.resolve({ slug: club.tenant.tenantSlug, id: booking.id }) },
    ).then(read);

    expect(res.status).toBe(403);
    expect(res.body.error?.code).toBe('CLUB_NOT_ACTIVE');
    expect(await statusOf(booking.id)).toBe('CONFIRMED');
  });
});
