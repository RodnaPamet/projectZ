import type { PrismaClient } from '@prisma/client';
import { NextRequest } from 'next/server';

import { deletionStanding } from '@/app-layer/usecases/account-deletion';
import { readPersonalData } from '@/app-layer/usecases/data-export';
import { POST as confirmRoute } from '@/app/api/v1/t/[slug]/admin/tournament-entries/[id]/confirm/route';
import { POST as declineRoute } from '@/app/api/v1/t/[slug]/admin/tournament-entries/[id]/decline/route';
import { POST as cancelRoute } from '@/app/api/v1/t/[slug]/admin/tournaments/[id]/cancel/route';
import { POST as openRoute } from '@/app/api/v1/t/[slug]/admin/tournaments/[id]/open/route';
import { GET as clubOneRoute } from '@/app/api/v1/t/[slug]/admin/tournaments/[id]/route';
import { POST as createRoute } from '@/app/api/v1/t/[slug]/admin/tournaments/route';
import { POST as enterRoute } from '@/app/api/v1/tournaments/[id]/entries/route';
import { GET as oneRoute } from '@/app/api/v1/tournaments/[id]/route';
import { GET as listRoute } from '@/app/api/v1/tournaments/route';
import { DELETE as withdrawRoute } from '@/app/api/v1/me/tournament-entries/[id]/route';
import { GET as clubPublicRoute } from '@/app/api/v1/clubs/[slug]/tournaments/route';
import { runAsSuperuser } from '@/lib/db/rls-middleware';

import { seedPlayer, signInAs, type TestIdentity } from '../helpers/auth';
import {
  prismaTestClient,
  seedAccount,
  seedTenant,
  seedVenue,
  type SeededTenant,
} from '../helpers/db';
import { asAppSuperuser } from '../helpers/rls';

/**
 * A CLUB'S TOURNAMENT, THROUGH THE ROUTES (#579; decisions 37–39, 50–53).
 *
 * The desk creates and opens one; players enter, alone or naming a partner;
 * the club confirms up to the draw size and the rest wait in order; the
 * entrant or the partner withdraws; a live entry holds up a deletion.
 */
const DAY = 86_400_000;

describe('a club tournament', () => {
  const db: PrismaClient = prismaTestClient();
  let club: SeededTenant;
  let venueId: string;
  let desk: TestIdentity;
  let ana: TestIdentity;
  let boris: TestIdentity;
  let cveta: TestIdentity;
  let dimo: TestIdentity;

  const playerIn = async (label: string) =>
    signInAs(db, {
      userId: await seedPlayer(db, club.tenantId, label),
      memberships: [{ tenantId: club.tenantId, tenantSlug: club.tenantSlug, role: 'PLAYER' }],
    });

  beforeEach(async () => {
    club = await seedTenant({}, db);
    ({ venueId } = await seedVenue(club.tenantId, {}, db));
    // The desk runs tournaments too (decision 52): a CLUB account holding STAFF.
    const deskId = await seedAccount('CLUB', db);
    await asAppSuperuser(db, (tx) =>
      tx.tenantMembership.create({
        data: { tenantId: club.tenantId, userId: deskId, role: 'STAFF', status: 'ACTIVE' },
      }),
    );
    desk = await signInAs(db, {
      userId: deskId,
      memberships: [{ tenantId: club.tenantId, tenantSlug: club.tenantSlug, role: 'STAFF' }],
    });
    [ana, boris, cveta, dimo] = await Promise.all(['ana', 'boris', 'cveta', 'dimo'].map(playerIn));
  });

  const call = async (
    route: (
      req: NextRequest,
      ctx: { params: Promise<Record<string, string>> },
    ) => Promise<Response>,
    method: 'GET' | 'POST' | 'DELETE',
    url: string,
    who: TestIdentity | null,
    params: Record<string, string> = {},
    body?: unknown,
  ) => {
    const res = await route(
      new NextRequest(`http://t${url}`, {
        method,
        headers: {
          'content-type': 'application/json',
          ...(who ? { authorization: `Bearer ${who.bearer}` } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
      { params: Promise.resolve(params) },
    );
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };

  const input = (over: Record<string, unknown> = {}) => ({
    name: 'Есенна купа',
    sport: 'PADEL',
    format: 'SINGLE_ELIMINATION',
    teamSize: 1,
    venueId,
    startsAt: new Date(Date.now() + 14 * DAY).toISOString(),
    drawSize: 2,
    entryFeeCents: 2000,
    feePayment: 'AT_CLUB',
    description: 'Две групи, после елиминации.',
    ...over,
  });

  const slug = () => club.tenantSlug;
  const create = (over: Record<string, unknown> = {}, who = desk) =>
    call(
      createRoute as never,
      'POST',
      `/api/v1/t/${slug()}/admin/tournaments`,
      who,
      { slug: slug() },
      input(over),
    );
  const open = (id: string) =>
    call(openRoute as never, 'POST', `/api/v1/t/${slug()}/admin/tournaments/${id}/open`, desk, {
      slug: slug(),
      id,
    });
  const enter = (id: string, who: TestIdentity, partnerUserId?: string) =>
    call(
      enterRoute as never,
      'POST',
      `/api/v1/tournaments/${id}/entries`,
      who,
      { id },
      partnerUserId ? { partnerUserId } : {},
    );
  const decide = (entryId: string, verb: 'confirm' | 'decline', who = desk) =>
    call(
      (verb === 'confirm' ? confirmRoute : declineRoute) as never,
      'POST',
      `/api/v1/t/${slug()}/admin/tournament-entries/${entryId}/${verb}`,
      who,
      {
        slug: slug(),
        id: entryId,
      },
    );
  const clubView = (id: string) =>
    call(clubOneRoute as never, 'GET', `/api/v1/t/${slug()}/admin/tournaments/${id}`, desk, {
      slug: slug(),
      id,
    });
  const withdraw = (entryId: string, who: TestIdentity) =>
    call(withdrawRoute as never, 'DELETE', `/api/v1/me/tournament-entries/${entryId}`, who, {
      id: entryId,
    });
  const bells = (userId: string, kind: string) =>
    asAppSuperuser(db, (tx) => tx.notification.count({ where: { userId, kind: kind as never } }));

  async function opened(over: Record<string, unknown> = {}): Promise<string> {
    const made = await create(over);
    expect(made.status).toBe(201);
    expect((await open(made.body.data.id)).status).toBe(200);
    return made.body.data.id as string;
  }

  it('the desk creates and opens one; players find it; a draft is nobody’s to see', async () => {
    const made = await create();
    expect(made.status).toBe(201);
    const id = made.body.data.id as string;
    expect(
      (await call(oneRoute as never, 'GET', `/api/v1/tournaments/${id}`, null, { id })).status,
    ).toBe(404);

    await open(id);
    const one = await call(oneRoute as never, 'GET', `/api/v1/tournaments/${id}`, null, { id });
    expect(one.body.data).toMatchObject({
      name: 'Есенна купа',
      entriesOpen: true,
      drawSize: 2,
      myEntry: null,
    });
    const list = await call(listRoute as never, 'GET', '/api/v1/tournaments?sport=PADEL', null);
    expect(list.body.data.items.map((t: { id: string }) => t.id)).toContain(id);
    const clubs = await call(
      clubPublicRoute as never,
      'GET',
      `/api/v1/clubs/${slug()}/tournaments`,
      null,
      { slug: slug() },
    );
    expect(clubs.body.data.items.map((t: { id: string }) => t.id)).toEqual([id]);
  });

  it('a player is not the club’s desk; an online fee waits for #581', async () => {
    expect((await create({}, ana)).status).toBe(403);
    expect((await create({ feePayment: 'ONLINE' })).body.error.code).toBe(
      'TOURNAMENT_ONLINE_FEE_UNAVAILABLE',
    );
    // Americano: players sign up alone, and the partners rotate (60).
    expect((await create({ format: 'AMERICANO', teamSize: 2 })).body.error).toMatchObject({
      code: 'TOURNAMENT_INVALID',
      details: { field: 'teamSize' },
    });
  });

  it('singles: entries wait for the club, up to the draw; the rest queue; a withdrawal frees a place', async () => {
    const id = await opened({ drawSize: 2 });
    const a = await enter(id, ana);
    expect(a.status).toBe(201);
    expect(a.body.data.myEntry).toMatchObject({
      status: 'PENDING',
      role: 'entrant',
      waitingPosition: null,
    });
    expect(await bells(desk.userId, 'TOURNAMENT_ENTRY_RECEIVED')).toBe(1);
    expect((await enter(id, ana)).body.error.code).toBe('TOURNAMENT_ALREADY_ENTERED');
    await enter(id, boris);
    const c = await enter(id, cveta);
    // Two places, three waiting: Цвета is first on the waiting list.
    expect(c.body.data.myEntry.waitingPosition).toBe(1);

    const entries = (await clubView(id)).body.data.entries as Array<{
      id: string;
      player: { userId: string };
    }>;
    const of = (who: TestIdentity) => entries.find((e) => e.player.userId === who.userId)!.id;
    expect((await decide(of(ana), 'confirm')).body.data.confirmed).toBe(1);
    await decide(of(boris), 'confirm');
    expect(await bells(ana.userId, 'TOURNAMENT_ENTRY_DECIDED')).toBe(1);
    expect((await decide(of(cveta), 'confirm')).body.error.code).toBe('TOURNAMENT_DRAW_FULL');

    // Борис withdraws; the desk is told; Цвета now fits.
    const w = await withdraw(of(boris), boris);
    expect(w.status).toBe(200);
    expect(await bells(desk.userId, 'TOURNAMENT_ENTRY_WITHDRAWN')).toBe(1);
    expect((await decide(of(cveta), 'confirm')).status).toBe(200);
    // A stranger's entry is not theirs to withdraw.
    expect((await withdraw(of(ana), dimo)).status).toBe(404);
    // Борис can come back, at the back of the queue.
    expect((await enter(id, boris)).body.data.myEntry).toMatchObject({
      status: 'PENDING',
      waitingPosition: 1,
    });
  });

  it('doubles: the entrant names a partner, who is told and may withdraw (decision 50)', async () => {
    const id = await opened({ teamSize: 2, drawSize: 4 });
    expect((await enter(id, ana)).body.error.code).toBe('TOURNAMENT_PARTNER_REQUIRED');
    expect((await enter(id, ana, ana.userId)).body.error.code).toBe(
      'TOURNAMENT_PARTNER_UNAVAILABLE',
    );

    const pair = await enter(id, ana, boris.userId);
    expect(pair.status).toBe(201);
    expect(pair.body.data.myEntry.partner).toMatchObject({ userId: boris.userId });
    expect(await bells(boris.userId, 'TOURNAMENT_PARTNER_NAMED')).toBe(1);
    // Boris sees it as his, as the partner; he cannot be in a second pair.
    const forBoris = await call(oneRoute as never, 'GET', `/api/v1/tournaments/${id}`, boris, {
      id,
    });
    expect(forBoris.body.data.myEntry).toMatchObject({
      role: 'partner',
      partner: { userId: ana.userId },
    });
    expect((await enter(id, cveta, boris.userId)).body.error.code).toBe(
      'TOURNAMENT_PARTNER_UNAVAILABLE',
    );

    // The partner withdraws; the entrant is told.
    expect((await withdraw(forBoris.body.data.myEntry.id, boris)).status).toBe(200);
    expect(await bells(ana.userId, 'TOURNAMENT_ENTRY_WITHDRAWN')).toBe(1);
    // Boris is free again: Цвета names him.
    expect((await enter(id, cveta, boris.userId)).status).toBe(201);
  });

  it('a cancelled tournament tells every live entry', async () => {
    const id = await opened();
    await enter(id, ana);
    await enter(id, boris);
    const res = await call(
      cancelRoute as never,
      'POST',
      `/api/v1/t/${slug()}/admin/tournaments/${id}/cancel`,
      desk,
      {
        slug: slug(),
        id,
      },
    );
    expect(res.body.data.status).toBe('CANCELLED');
    expect(await bells(ana.userId, 'TOURNAMENT_ENTRY_DECIDED')).toBe(1);
    expect(await bells(boris.userId, 'TOURNAMENT_ENTRY_DECIDED')).toBe(1);
    expect((await enter(id, cveta)).body.error.code).toBe('TOURNAMENT_NOT_OPEN');
  });

  it('a live entry holds up the account’s deletion until it is withdrawn (#465)', async () => {
    const id = await opened({ teamSize: 2 });
    const pair = await enter(id, ana, boris.userId);
    for (const who of [ana, boris]) {
      const standing = await runAsSuperuser((tx) => deletionStanding(tx, who.userId));
      expect(standing).toMatchObject({ kind: 'blocked', tournaments: 1 });
    }
    await withdraw(pair.body.data.myEntry.id, ana);
    const after = await runAsSuperuser((tx) => deletionStanding(tx, boris.userId));
    expect(after.kind).toBe('allowed');
  });

  it('the partner’s export has the entry, and not the entrant (#582)', async () => {
    const id = await opened({ teamSize: 2 });
    await enter(id, ana, boris.userId);
    const exported = await runAsSuperuser((tx) => readPersonalData(tx, boris.userId));
    expect(exported!.tournaments.entries).toEqual([
      expect.objectContaining({
        tournament: 'Есенна купа',
        status: 'PENDING',
        role: 'partner',
        withPartner: true,
        withdrewItYourself: false,
      }),
    ]);
    expect(JSON.stringify(exported!.tournaments)).not.toContain(ana.userId);
  });
});
