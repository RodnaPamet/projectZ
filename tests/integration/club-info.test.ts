import type { Role } from '@prisma/client';
import { NextRequest } from 'next/server';

import { DESCRIPTION_MAX } from '@/app-layer/usecases/club-info';
import { loadClubPublicPage } from '@/app-layer/usecases/club-public-page';
import { kindForRole } from '@/lib/auth/account-kind';

import { prismaTestClient, resetDatabase, seedTenant, type SeededTenant } from '../helpers/db';
import { asAppSuperuser } from '../helpers/rls';

/**
 * «Информация» (#530, #536): a club writes its own description, and each
 * venue's description and phone, through the real actions against a real
 * database.
 *
 * What matters: the text is stored as plain text whatever was typed, the
 * limit is measured after the markup is gone, every change leaves a before
 * and an after, only OWNER and MANAGER may, and one club cannot reach
 * another's venue.
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

import {
  saveClubDescriptionAction,
  saveVenueInfoAction,
} from '@/app/(app)/t/[slug]/admin/photos/actions';
import { GET as clubRoute } from '@/app/api/v1/clubs/[slug]/route';

describe('a club’s own «Информация» (#530, #536)', () => {
  const db = prismaTestClient();
  let club: SeededTenant;
  let other: SeededTenant;
  let venueId: string;
  let otherVenueId: string;

  async function venueFor(tenantId: string, tag: string) {
    const v = await asAppSuperuser(db, (tx) =>
      tx.venue.create({
        data: {
          tenantId,
          name: `Site ${tag}`,
          slug: `site-${tag}-${tenantId.slice(-8)}`,
          addressLine: 'bul. Vitosha 1',
          city: 'Sofia',
          lat: 42.6977,
          lng: 23.3219,
          email: `site-${tag}-${tenantId.slice(-8)}@test.invalid`,
          description: 'Typed at onboarding',
          phone: '+359 2 111 222',
        },
        select: { id: true },
      }),
    );
    return v.id;
  }

  async function member(tenant: SeededTenant, role: Role): Promise<string> {
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
        data: { tenantId: tenant.tenantId, userId: user.id, role, status: 'ACTIVE' },
      }),
    );
    return user.id;
  }

  const form = (fields: Record<string, string>) => {
    const f = new FormData();
    for (const [k, v] of Object.entries(fields)) f.set(k, v);
    return f;
  };
  const saveClub = (text: string, slug = club.tenantSlug) =>
    saveClubDescriptionAction(slug, null, form({ description: text }));
  const saveVenue = (id: string, fields: { description: string; phone: string }) =>
    saveVenueInfoAction(club.tenantSlug, id, null, form(fields));

  const clubRow = (tenantId = club.tenantId) =>
    asAppSuperuser(db, (tx) =>
      tx.venueOrg.findUniqueOrThrow({ where: { id: tenantId }, select: { description: true } }),
    );
  const venueRow = (id: string) =>
    asAppSuperuser(db, (tx) =>
      tx.venue.findUniqueOrThrow({
        where: { id },
        select: { description: true, phone: true },
      }),
    );
  const audits = (action: string) =>
    asAppSuperuser(db, (tx) =>
      tx.auditEntry.findMany({
        where: { tenantId: club.tenantId, action },
        select: { actorUserId: true, entity: true, entityId: true, detailsJson: true },
        orderBy: { createdAt: 'asc' },
      }),
    );

  beforeEach(async () => {
    await resetDatabase(db);
    club = await seedTenant({}, db);
    other = await seedTenant({}, db);
    signedInAs = club.userId;
    venueId = await venueFor(club.tenantId, 'a');
    otherVenueId = await venueFor(other.tenantId, 'b');
  });

  // ─── the club's description ────────────────────────────────────────

  it('the owner writes the club’s description: plain text, the club’s own line breaks, audited', async () => {
    await expect(
      saveClub(
        '  <b>Тенис клуб</b> от 1998 г.\r\n\r\n\r\n\r\nШест корта, <script>alert(1)</script>треньори и школа.  ',
      ),
    ).resolves.toEqual({ ok: true });

    const stored = (await clubRow()).description;
    expect(stored).toBe('Тенис клуб от 1998 г.\n\nШест корта, треньори и школа.');

    const [entry] = await audits('CLUB_DESCRIPTION_CHANGED');
    expect(entry).toMatchObject({
      actorUserId: club.userId,
      entity: 'VenueOrg',
      entityId: club.tenantId,
      detailsJson: { before: { description: null }, after: { description: stored } },
    });
    // The other club's row is untouched.
    expect((await clubRow(other.tenantId)).description).toBeNull();
  });

  it('the public page and the v1 club carry it; an empty text clears it', async () => {
    await saveClub('Клуб за падел в Лозенец.');
    const page = await asAppSuperuser(db, (tx) => loadClubPublicPage(tx, club.tenantSlug));
    expect(page!.description).toBe('Клуб за падел в Лозенец.');

    const res = await clubRoute(
      new NextRequest(`http://localhost/api/v1/clubs/${club.tenantSlug}`),
      { params: Promise.resolve({ slug: club.tenantSlug }) },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { description: string | null } };
    expect(body.data.description).toBe('Клуб за падел в Лозенец.');

    await expect(saveClub('   \n  ')).resolves.toEqual({ ok: true });
    expect((await clubRow()).description).toBeNull();
    expect(await audits('CLUB_DESCRIPTION_CHANGED')).toHaveLength(2);
  });

  it('saving the same text again changes nothing and writes no second audit row', async () => {
    await saveClub('Същият текст.');
    await saveClub('Същият текст.  ');
    expect(await audits('CLUB_DESCRIPTION_CHANGED')).toHaveLength(1);
  });

  it('the limit is measured after the markup is gone, and a text over it is refused whole', async () => {
    const atLimit = 'я'.repeat(DESCRIPTION_MAX);
    // Markup around a text exactly at the limit does not push it over.
    await expect(saveClub(`<p>${atLimit}</p>`)).resolves.toEqual({ ok: true });
    expect((await clubRow()).description).toBe(atLimit);

    await expect(saveClub(`${atLimit}я`)).resolves.toEqual({ ok: false, error: 'TOO_LONG' });
    expect((await clubRow()).description).toBe(atLimit);
  });

  it('the database stops a text the use case never saw', async () => {
    await expect(
      asAppSuperuser(db, (tx) =>
        tx.venueOrg.update({
          where: { id: club.tenantId },
          data: { description: 'x'.repeat(2001) },
        }),
      ),
    ).rejects.toThrow(/venue_org_description_length/);
  });

  // ─── a venue's description and phone ───────────────────────────────

  it('the owner writes a venue’s description and phone, audited with before and after', async () => {
    await expect(
      saveVenue(venueId, { description: 'Четири <i>закрити</i> корта.', phone: ' 02  987 65 43 ' }),
    ).resolves.toEqual({ ok: true });
    expect(await venueRow(venueId)).toEqual({
      description: 'Четири закрити корта.',
      phone: '02 987 65 43',
    });
    const [entry] = await audits('VENUE_INFO_CHANGED');
    expect(entry).toMatchObject({
      entity: 'Venue',
      entityId: venueId,
      detailsJson: {
        before: { description: 'Typed at onboarding', phone: '+359 2 111 222' },
        after: { description: 'Четири закрити корта.', phone: '02 987 65 43' },
      },
    });
  });

  it('empty fields clear them; a phone that is not a number is refused and nothing changes', async () => {
    await expect(
      saveVenue(venueId, { description: 'Нов текст', phone: 'обадете се' }),
    ).resolves.toEqual({ ok: false, error: 'PHONE_INVALID' });
    expect(await venueRow(venueId)).toEqual({
      description: 'Typed at onboarding',
      phone: '+359 2 111 222',
    });

    await expect(saveVenue(venueId, { description: '', phone: '' })).resolves.toEqual({ ok: true });
    expect(await venueRow(venueId)).toEqual({ description: null, phone: null });
  });

  it('another club’s venue is not found, and is left as it was', async () => {
    await expect(
      saveVenue(otherVenueId, { description: 'Наш е', phone: '02 000 0000' }),
    ).resolves.toEqual({ ok: false, error: 'VENUE_NOT_FOUND' });
    expect(await venueRow(otherVenueId)).toEqual({
      description: 'Typed at onboarding',
      phone: '+359 2 111 222',
    });
  });

  // ─── who may ───────────────────────────────────────────────────────

  it('a MANAGER may; STAFF, COACH and a player of the club may not', async () => {
    signedInAs = await member(club, 'MANAGER');
    await expect(saveClub('От управителя.')).resolves.toEqual({ ok: true });

    for (const role of ['STAFF', 'COACH', 'PLAYER'] as const) {
      signedInAs = await member(club, role);
      await expect(saveClub('Не бива.')).rejects.toThrow();
      await expect(saveVenue(venueId, { description: 'Не бива.', phone: '' })).rejects.toThrow();
    }
    expect((await clubRow()).description).toBe('От управителя.');
    expect((await venueRow(venueId)).description).toBe('Typed at onboarding');
  });

  it('an owner of one club cannot write another club’s description', async () => {
    await expect(saveClub('Чужд клуб.', other.tenantSlug)).rejects.toThrow();
    expect((await clubRow(other.tenantId)).description).toBeNull();
  });
});
