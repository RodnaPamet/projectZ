import type { Role } from '@prisma/client';

import { kindForRole } from '@/lib/auth/account-kind';

import { prismaTestClient, resetDatabase, seedTenant, type SeededTenant } from '../helpers/db';
import { asAppSuperuser } from '../helpers/rls';

/**
 * THE CAP SETTING ON /admin/pricing (#380): who may change it, what it accepts,
 * and that every change is audited.
 *
 * The action is called for real against a real database. Only the SESSION is
 * stood in for: `requireTenantAction` is replaced by one that resolves the
 * caller with the real `membershipContext` — the same database read of role
 * and permissions the page does — so a role lacking `admin.venue_manage` is
 * refused by the real permission table, not by a test double's opinion.
 */

let signedInAs = '';

jest.mock('next/cache', () => ({ revalidatePath: jest.fn(), revalidateTag: jest.fn() }));
jest.mock('@/lib/auth/page-context', () => {
  const actual = jest.requireActual('@/lib/auth/page-context');
  return {
    ...actual,
    requireTenantAction: async (slug: string, permission: string) => {
      const res = await actual.membershipContext(signedInAs, slug);
      if (res.kind !== 'ok' || !res.ctx.permissions.includes(permission)) {
        throw new actual.TenantActionDeniedError(slug, permission);
      }
      return res.ctx;
    },
  };
});

// Imported after the mocks, which jest hoists anyway; kept here for the reader.
import { setOnlineBookingCapAction } from '@/app/(app)/t/[slug]/admin/pricing/actions';

describe('setOnlineBookingCapAction', () => {
  const db = prismaTestClient();
  let club: SeededTenant;

  async function member(role: Role): Promise<string> {
    const user = await asAppSuperuser(db, (tx) =>
      tx.user.create({
        data: {
          email: `${role.toLowerCase()}-${Math.random().toString(36).slice(2, 8)}@test.invalid`,
          name: role,
          accountKind: kindForRole(role),
        },
        select: { id: true },
      }),
    );
    await asAppSuperuser(db, (tx) =>
      tx.tenantMembership.create({
        data: { tenantId: club.tenantId, userId: user.id, role, status: 'ACTIVE' },
      }),
    );
    return user.id;
  }

  const form = (limit: string) => {
    const f = new FormData();
    f.set('limit', limit);
    return f;
  };

  const capNow = async () =>
    (
      await asAppSuperuser(db, (tx) =>
        tx.venueOrg.findUniqueOrThrow({ where: { id: club.tenantId } }),
      )
    ).maxUpcomingOnlineBookings;

  const audits = () =>
    asAppSuperuser(db, (tx) =>
      tx.auditEntry.findMany({
        where: { tenantId: club.tenantId, action: 'CLUB_ONLINE_BOOKING_CAP_CHANGED' },
        orderBy: { createdAt: 'asc' },
        take: 10,
      }),
    );

  beforeEach(async () => {
    await resetDatabase(db);
    club = await seedTenant({}, db);
  });

  it('THE POINT: the OWNER changes it, and the change is audited with before and after', async () => {
    signedInAs = club.userId;

    await expect(setOnlineBookingCapAction(club.tenantSlug, null, form('5'))).resolves.toEqual({
      ok: true,
    });

    expect(await capNow()).toBe(5);
    const rows = await audits();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actorUserId: club.userId,
      entity: 'VenueOrg',
      entityId: club.tenantId,
    });
    expect(rows[0]!.detailsJson).toMatchObject({
      before: { maxUpcomingOnlineBookings: 3 },
      after: { maxUpcomingOnlineBookings: 5 },
    });
  });

  it('a MANAGER may change it too', async () => {
    signedInAs = await member('MANAGER');

    await expect(setOnlineBookingCapAction(club.tenantSlug, null, form('1'))).resolves.toEqual({
      ok: true,
    });
    expect(await capNow()).toBe(1);
    expect((await audits())[0]!.actorUserId).toBe(signedInAs);
  });

  it.each(['STAFF', 'COACH', 'PLAYER'] as const)(
    'a %s may not — refused, unchanged, nothing audited',
    async (role) => {
      signedInAs = await member(role);

      await expect(
        setOnlineBookingCapAction(club.tenantSlug, null, form('9')),
      ).rejects.toMatchObject({ name: 'TenantActionDeniedError' });
      expect(await capNow()).toBe(3);
      expect(await audits()).toHaveLength(0);
    },
  );

  it('the OWNER of ANOTHER club may not', async () => {
    const other = await seedTenant({}, db);
    signedInAs = other.userId;

    await expect(setOnlineBookingCapAction(club.tenantSlug, null, form('9'))).rejects.toMatchObject(
      {
        name: 'TenantActionDeniedError',
      },
    );
    expect(await capNow()).toBe(3);
  });

  it.each(['0', '51', '2.5', '', 'abc', '-1'])(
    'refuses %j as INVALID, and writes nothing',
    async (raw) => {
      signedInAs = club.userId;

      await expect(setOnlineBookingCapAction(club.tenantSlug, null, form(raw))).resolves.toEqual({
        ok: false,
        error: 'INVALID',
      });
      expect(await capNow()).toBe(3);
      expect(await audits()).toHaveLength(0);
    },
  );

  it('accepts both ends of the range', async () => {
    signedInAs = club.userId;
    await setOnlineBookingCapAction(club.tenantSlug, null, form('50'));
    expect(await capNow()).toBe(50);
    await setOnlineBookingCapAction(club.tenantSlug, null, form('1'));
    expect(await capNow()).toBe(1);
    expect(await audits()).toHaveLength(2);
  });

  it('saving the same value is not a change, and is not audited', async () => {
    signedInAs = club.userId;
    await setOnlineBookingCapAction(club.tenantSlug, null, form('3'));
    expect(await audits()).toHaveLength(0);
  });

  it('the database refuses an out-of-range value even past the use case', async () => {
    await expect(
      asAppSuperuser(db, (tx) =>
        tx.venueOrg.update({
          where: { id: club.tenantId },
          data: { maxUpcomingOnlineBookings: 0 },
        }),
      ),
    ).rejects.toThrow(/venue_org_max_upcoming_online_bookings_range/);
  });
});
