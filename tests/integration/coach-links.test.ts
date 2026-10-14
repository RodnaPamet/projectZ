import { NextRequest } from 'next/server';

import { DELETE as linkDelete, PUT as linkPut } from '@/app/api/v1/me/coach-links/[id]/route';
import { PUT as hoursPut } from '@/app/api/v1/me/coach-links/[id]/hours/route';
import { GET as linksGet, POST as linksPost } from '@/app/api/v1/me/coach-links/route';
import { DELETE as timeOffDelete } from '@/app/api/v1/me/coach-time-off/[id]/route';
import { GET as timeOffGet, POST as timeOffPost } from '@/app/api/v1/me/coach-time-off/route';
import { deleteAccount } from '@/app-layer/usecases/account-deletion';
import { coachCards } from '@/app-layer/usecases/coach-directory';
import {
  notifyCoachLinkAnswered,
  notifyCoachLinkRequested,
} from '@/app-layer/usecases/coach-link-notifications';
import {
  answerCoachRequest,
  endCoachLink,
  listClubCoaches,
} from '@/app-layer/usecases/coach-links';
import { coachToday } from '@/app-layer/usecases/coach-time-off';
import { listStaff } from '@/app-layer/repositories/staff';
import { acceptInvite, createInvite } from '@/app-layer/usecases/invites';
import { changeMemberRole, setMemberSuspended } from '@/app-layer/usecases/staff';
import { runAsSuperuser, runAsUserOnly, runInTenantContext } from '@/lib/db/rls-middleware';
import { clearAllRateLimits } from '@/lib/security/rate-limit';

import { signInAs } from '../helpers/auth';
import {
  prismaTestClient,
  resetDatabase,
  seedAccount,
  seedTenant,
  seedVenue,
  type SeededTenant,
} from '../helpers/db';
import { asAppSuperuser, asAppUser } from '../helpers/rls';

/**
 * A COACH AND A CLUB'S VENUE (#546, #377), through the coach's real routes
 * and the club's use cases, against a real database.
 *
 *   - an approved coach asks; the club accepts or declines; either side ends;
 *   - a club's email invitation, accepted, makes the coach teach there;
 *   - the terms a coach sets, held to the lengths the venue's courts allow;
 *   - weekly hours and days off;
 *   - the coach's standing at the club follows the links;
 *   - one coach cannot touch another's link, and a club cannot touch another
 *     club's.
 */

const db = prismaTestClient();

type Json = { data?: Record<string, unknown>; error?: { code: string; details?: unknown } };
type Route = (req: NextRequest, ctx: never) => Promise<Response>;

async function call(
  route: unknown,
  url: string,
  init: { method?: string; bearer?: string; json?: unknown } = {},
  params?: Record<string, string>,
): Promise<{ status: number; json: Json }> {
  const headers: Record<string, string> = {};
  if (init.bearer) headers.authorization = `Bearer ${init.bearer}`;
  if (init.json !== undefined) headers['content-type'] = 'application/json';
  const req = new NextRequest(`http://t${url}`, {
    method: init.method ?? 'GET',
    headers,
    body: init.json === undefined ? undefined : JSON.stringify(init.json),
  });
  const res = await (route as Route)(req, { params: Promise.resolve(params ?? {}) } as never);
  return { status: res.status, json: (await res.json()) as Json };
}

interface LinkDto {
  id: string;
  status: string;
  startedBy: string;
  club: { name: string; slug: string };
  venue: { id: string; name: string };
  lengthOptions: number[];
  hourlyRateCents: number | null;
  groupRateCents: number | null;
  lessonMinutes: number[];
  cancelCutoffHours: number;
  hours: Array<{ dayOfWeek: number; open: string; close: string }>;
  missing: string[];
}
const linksOf = (r: { json: Json }) => (r.json.data as unknown as { links: LinkDto[] }).links;

const myLinks = (bearer: string) => call(linksGet, '/api/v1/me/coach-links', { bearer });
const ask = (bearer: string, venueId: unknown) =>
  call(linksPost, '/api/v1/me/coach-links', { method: 'POST', bearer, json: { venueId } });
const setTerms = (bearer: string, id: string, json: unknown) =>
  call(linkPut, `/api/v1/me/coach-links/${id}`, { method: 'PUT', bearer, json }, { id });
const endMine = (bearer: string, id: string) =>
  call(linkDelete, `/api/v1/me/coach-links/${id}`, { method: 'DELETE', bearer }, { id });
const setHours = (bearer: string, id: string, hours: unknown) =>
  call(
    hoursPut,
    `/api/v1/me/coach-links/${id}/hours`,
    { method: 'PUT', bearer, json: { hours } },
    { id },
  );

let clubA: SeededTenant;
let clubB: SeededTenant;
let venueA: { venueId: string; resourceId: string };
let venueA2: { venueId: string; resourceId: string };
let venueB: { venueId: string; resourceId: string };

/** A coach account; with `approved`, one the platform approved. */
async function coach(name: string, opts: { approved?: boolean } = {}) {
  const userId = await seedAccount('COACH', db);
  const admin = await seedAccount('PLAYER', db);
  await asAppSuperuser(db, async (tx) => {
    await tx.user.update({ where: { id: userId }, data: { name } });
    if (opts.approved === false) return;
    // Approved as the platform does it: bound to an admin, naming them (P72).
    await tx.$executeRawUnsafe(`SELECT set_config('app.platform_admin_id', $1, true)`, admin);
    await tx.coachProfile.create({
      data: {
        userId,
        slug: `coach-${userId.slice(-8).toLowerCase()}`,
        bio: `Представяне на ${name}: тенис и падел от 2010 г.`,
        qualifications: 'Лиценз ББФТ',
        status: 'APPROVED',
        submittedAt: new Date(),
        decidedAt: new Date(),
        decidedByUserId: admin,
        sports: { create: [{ sport: 'PADEL', levelMin: 1, levelMax: 5 }] },
      },
    });
  });
  return signInAs(db, { userId, memberships: [] });
}

const asClub = <T>(club: SeededTenant, fn: Parameters<typeof runInTenantContext<T>>[1]) =>
  runInTenantContext(club.tenantId, fn);
const actor = (club: SeededTenant) => ({ tenantId: club.tenantId, actorUserId: club.userId });

const membership = (club: SeededTenant, userId: string) =>
  asAppSuperuser(db, (tx) =>
    tx.tenantMembership.findUnique({
      where: { userId_tenantId: { userId, tenantId: club.tenantId } },
      select: { role: true, status: true },
    }),
  );
const audit = (club: SeededTenant) =>
  asAppSuperuser(db, (tx) =>
    tx.auditEntry.findMany({
      where: { tenantId: club.tenantId, action: { startsWith: 'COACH_' } },
      orderBy: { createdAt: 'asc' },
      select: { action: true, actorUserId: true },
    }),
  );

/** A coach teaching at venue A: asked, and accepted by the club. */
async function teachingAtA(name = 'Иван Петров') {
  const c = await coach(name);
  const asked = await ask(c.bearer, venueA.venueId);
  const linkId = linksOf(asked)[0]!.id;
  await asClub(clubA, (tx) => answerCoachRequest(tx, actor(clubA), linkId, true));
  return { ...c, linkId };
}

beforeEach(async () => {
  await resetDatabase(db);
  await clearAllRateLimits();
  clubA = await seedTenant({ name: 'Club A' }, db);
  clubB = await seedTenant({ name: 'Club B' }, db);
  venueA = await seedVenue(clubA.tenantId, { name: 'Venue A' }, db);
  venueA2 = await seedVenue(clubA.tenantId, { name: 'Venue A2' }, db);
  venueB = await seedVenue(clubB.tenantId, { name: 'Venue B' }, db);
});

// ─── Asking ────────────────────────────────────────────────────────────────

describe('a coach asks to teach at a venue', () => {
  it('is for coach accounts, and needs the platform’s approval first', async () => {
    expect((await myLinks('')).status).toBe(401);
    const player = await signInAs(db, { userId: await seedAccount('PLAYER', db), memberships: [] });
    for (const res of [await myLinks(player.bearer), await ask(player.bearer, venueA.venueId)]) {
      expect(res.status).toBe(403);
      expect(res.json.error?.code).toBe('COACH_ACCOUNT_REQUIRED');
    }

    const fresh = await coach('Нов Треньор', { approved: false });
    const list = await myLinks(fresh.bearer);
    expect(list.json.data).toEqual({ approved: false, links: [] });
    const refused = await ask(fresh.bearer, venueA.venueId);
    expect(refused.status).toBe(403);
    expect(refused.json.error?.code).toBe('COACH_NOT_APPROVED');
    expect(await asAppSuperuser(db, (tx) => tx.coach.count())).toBe(0);
  });

  it('makes a request the club sees, with the coach’s public card and nothing else', async () => {
    const c = await coach('Иван Петров');
    const res = await ask(c.bearer, venueA.venueId);
    expect(res.status).toBe(201);
    expect(res.json.data!.approved).toBe(true);
    const [link] = linksOf(res);
    expect(link).toMatchObject({
      status: 'REQUESTED',
      startedBy: 'COACH',
      club: { name: 'Club A', slug: clubA.tenantSlug },
      venue: { id: venueA.venueId, name: 'Venue A' },
      // The seeded court: booked by the hour, for up to three. Whole hours,
      // though a booking may start on the half hour.
      lengthOptions: [60, 120, 180],
      hourlyRateCents: null,
      lessonMinutes: [],
      hours: [],
      // Not yet a link to book on: nothing is "missing" until it is active.
      missing: [],
    });

    const seen = await listClubCoaches(clubA.tenantId);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      id: link!.id,
      status: 'REQUESTED',
      venue: { id: venueA.venueId, name: 'Venue A' },
      coach: {
        userId: c.userId,
        name: 'Иван Петров',
        approved: true,
        bio: expect.stringContaining('тенис и падел'),
        qualifications: 'Лиценз ББФТ',
        sports: [{ sport: 'PADEL', levelMin: 1, levelMax: 5 }],
      },
    });
    // Never an address, a phone, or anything about a certificate.
    expect(JSON.stringify(seen)).not.toMatch(/@playerz\.test|email|phone|certificate/i);
    // The other club sees nothing of it.
    expect(await listClubCoaches(clubB.tenantId)).toEqual([]);
    // Asking made the coach nothing at the club yet.
    expect(await membership(clubA, c.userId)).toBeNull();
    expect(await audit(clubA)).toEqual([{ action: 'COACH_REQUESTED', actorUserId: c.userId }]);
  });

  it('refuses a venue that does not exist, one that is closed, and one whose club is suspended', async () => {
    const c = await coach('Иван Петров');
    expect((await ask(c.bearer, 'cnosuchvenue0000000000000')).json.error?.code).toBe(
      'VENUE_NOT_FOUND',
    );
    expect((await ask(c.bearer, 42)).status).toBe(400);

    await asAppSuperuser(db, (tx) =>
      tx.venue.update({ where: { id: venueA2.venueId }, data: { status: 'CLOSED' } }),
    );
    expect((await ask(c.bearer, venueA2.venueId)).status).toBe(404);

    await asAppSuperuser(db, (tx) =>
      tx.venueOrg.update({ where: { id: clubB.tenantId }, data: { status: 'SUSPENDED' } }),
    );
    expect((await ask(c.bearer, venueB.venueId)).status).toBe(404);
    expect(await asAppSuperuser(db, (tx) => tx.coach.count())).toBe(0);
  });

  it('once is enough: asking again while it waits or runs is refused; after a decline it starts over', async () => {
    const c = await coach('Иван Петров');
    const linkId = linksOf(await ask(c.bearer, venueA.venueId))[0]!.id;
    const again = await ask(c.bearer, venueA.venueId);
    expect(again.status).toBe(409);
    expect(again.json.error).toMatchObject({
      code: 'COACH_LINK_EXISTS',
      details: { status: 'REQUESTED' },
    });

    await asClub(clubA, (tx) => answerCoachRequest(tx, actor(clubA), linkId, false));
    expect(linksOf(await myLinks(c.bearer))[0]!.status).toBe('DECLINED');
    // A declined coach is nothing at the club.
    expect(await membership(clubA, c.userId)).toBeNull();

    const anew = await ask(c.bearer, venueA.venueId);
    expect(anew.status).toBe(201);
    // The same row, asked for again: one link per coach and venue.
    expect(linksOf(anew).map((l) => [l.id, l.status])).toEqual([[linkId, 'REQUESTED']]);

    await asClub(clubA, (tx) => answerCoachRequest(tx, actor(clubA), linkId, true));
    expect((await ask(c.bearer, venueA.venueId)).json.error?.details).toEqual({ status: 'ACTIVE' });
    // Another venue of the same club is another request.
    expect((await ask(c.bearer, venueA2.venueId)).status).toBe(201);
  });

  it('two requests at once make one link', async () => {
    const c = await coach('Иван Петров');
    const results = await Promise.all([
      ask(c.bearer, venueA.venueId),
      ask(c.bearer, venueA.venueId),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(await asAppSuperuser(db, (tx) => tx.coach.count())).toBe(1);
  });

  it('a person the club suspended is not taken on, by asking or by accepting', async () => {
    const c = await coach('Иван Петров');
    await asAppSuperuser(db, (tx) =>
      tx.tenantMembership.create({
        data: { tenantId: clubA.tenantId, userId: c.userId, role: 'PLAYER', status: 'SUSPENDED' },
      }),
    );
    const res = await ask(c.bearer, venueA.venueId);
    expect(res.status).toBe(403);
    expect(res.json.error?.code).toBe('COACH_SUSPENDED_AT_CLUB');

    // Suspended AFTER asking: the club lifts that before it accepts.
    const other = await coach('Мария Илиева');
    const linkId = linksOf(await ask(other.bearer, venueA.venueId))[0]!.id;
    await asAppSuperuser(db, (tx) =>
      tx.tenantMembership.create({
        data: {
          tenantId: clubA.tenantId,
          userId: other.userId,
          role: 'PLAYER',
          status: 'SUSPENDED',
        },
      }),
    );
    await expect(
      asClub(clubA, (tx) => answerCoachRequest(tx, actor(clubA), linkId, true)),
    ).rejects.toMatchObject({ name: 'CoachSuspendedAtClubError' });
    expect(linksOf(await myLinks(other.bearer))[0]!.status).toBe('REQUESTED');
  });
});

// ─── The club answers ──────────────────────────────────────────────────────

describe('the club answers, and the coach’s standing follows', () => {
  it('accepting makes the coach one of the club’s; a coach who already plays there becomes its coach', async () => {
    const c = await coach('Иван Петров');
    // The coach booked a court here once: a player at this club.
    await asAppSuperuser(db, (tx) =>
      tx.tenantMembership.create({
        data: { tenantId: clubA.tenantId, userId: c.userId, role: 'PLAYER', status: 'ACTIVE' },
      }),
    );
    const linkId = linksOf(await ask(c.bearer, venueA.venueId))[0]!.id;
    await asClub(clubA, (tx) => answerCoachRequest(tx, actor(clubA), linkId, true));

    const [link] = linksOf(await myLinks(c.bearer));
    expect(link).toMatchObject({ status: 'ACTIVE', missing: ['rate', 'lengths', 'hours'] });
    expect(await membership(clubA, c.userId)).toEqual({ role: 'COACH', status: 'ACTIVE' });
    expect((await audit(clubA)).map((a) => a.action)).toEqual([
      'COACH_REQUESTED',
      'COACH_ACCEPTED',
    ]);

    // Decided once.
    await expect(
      asClub(clubA, (tx) => answerCoachRequest(tx, actor(clubA), linkId, false)),
    ).rejects.toMatchObject({ name: 'CoachLinkStateError', status: 'ACTIVE' });
  });

  it('a coach with no standing at the club gets one on acceptance, and loses the role when the last link ends', async () => {
    const c = await coach('Иван Петров');
    const first = linksOf(await ask(c.bearer, venueA.venueId))[0]!.id;
    await ask(c.bearer, venueA2.venueId);
    const second = linksOf(await myLinks(c.bearer)).find((l) => l.venue.id === venueA2.venueId)!.id;
    await asClub(clubA, async (tx) => {
      await answerCoachRequest(tx, actor(clubA), first, true);
      await answerCoachRequest(tx, actor(clubA), second, true);
    });
    expect(await membership(clubA, c.userId)).toEqual({ role: 'COACH', status: 'ACTIVE' });

    // The club ends one: still its coach, at the other venue.
    await asClub(clubA, (tx) => endCoachLink(tx, actor(clubA), first));
    expect(await membership(clubA, c.userId)).toEqual({ role: 'COACH', status: 'ACTIVE' });
    // The coach ends the other: a player there from now, not gone (a coach plays too).
    expect((await endMine(c.bearer, second)).status).toBe(200);
    expect(await membership(clubA, c.userId)).toEqual({ role: 'PLAYER', status: 'ACTIVE' });

    expect(linksOf(await myLinks(c.bearer)).map((l) => l.status)).toEqual(['ENDED', 'ENDED']);
    expect(await listClubCoaches(clubA.tenantId)).toEqual([]);
    const ended = (await audit(clubA)).filter((a) => a.action === 'COACH_LINK_ENDED');
    expect(ended.map((e) => e.actorUserId)).toEqual([clubA.userId, c.userId]);
    // Ended once.
    expect((await endMine(c.bearer, second)).json.error).toMatchObject({
      code: 'COACH_LINK_STATE',
      details: { status: 'ENDED' },
    });
  });

  it('a club cannot answer or end another club’s link', async () => {
    const c = await coach('Иван Петров');
    const linkId = linksOf(await ask(c.bearer, venueA.venueId))[0]!.id;
    for (const attempt of [
      () => asClub(clubB, (tx) => answerCoachRequest(tx, actor(clubB), linkId, true)),
      () => asClub(clubB, (tx) => endCoachLink(tx, actor(clubB), linkId)),
    ]) {
      await expect(attempt()).rejects.toMatchObject({ name: 'CoachLinkNotFoundError' });
    }
    expect(linksOf(await myLinks(c.bearer))[0]!.status).toBe('REQUESTED');
  });

  it('a coach can take a request back before it is answered', async () => {
    const c = await coach('Иван Петров');
    const linkId = linksOf(await ask(c.bearer, venueA.venueId))[0]!.id;
    expect(linksOf(await endMine(c.bearer, linkId))[0]!.status).toBe('ENDED');
    expect(await listClubCoaches(clubA.tenantId)).toEqual([]);
    await expect(
      asClub(clubA, (tx) => answerCoachRequest(tx, actor(clubA), linkId, true)),
    ).rejects.toMatchObject({ name: 'CoachLinkStateError', status: 'ENDED' });
  });
});

describe('a coach is not the club’s staff', () => {
  it('is not on the staff list (which carries an email), and the staff screen cannot change or suspend them', async () => {
    const c = await teachingAtA();
    expect(await membership(clubA, c.userId)).toEqual({ role: 'COACH', status: 'ACTIVE' });

    const staff = await asClub(clubA, (tx) => listStaff(tx, clubA.tenantId));
    expect(staff.map((m) => m.role)).toEqual(['OWNER']);
    expect(JSON.stringify(staff)).not.toContain(c.userId);

    const row = await asAppSuperuser(db, (tx) =>
      tx.tenantMembership.findUniqueOrThrow({
        where: { userId_tenantId: { userId: c.userId, tenantId: clubA.tenantId } },
        select: { id: true },
      }),
    );
    const owner = { userId: clubA.userId, canManageOwners: true };
    for (const attempt of [
      () => asClub(clubA, (tx) => setMemberSuspended(tx, clubA.tenantId, owner, row.id, true)),
      () => asClub(clubA, (tx) => changeMemberRole(tx, clubA.tenantId, owner, row.id, 'PLAYER')),
    ]) {
      await expect(attempt()).rejects.toMatchObject({ name: 'StaffMemberNotFoundError' });
    }
    expect(await membership(clubA, c.userId)).toEqual({ role: 'COACH', status: 'ACTIVE' });
  });
});

// ─── The club invites ──────────────────────────────────────────────────────

describe('a club invites a coach by email', () => {
  const invite = async (club: SeededTenant, email: string) =>
    (
      await runInTenantContext(club.tenantId, (tx) =>
        createInvite(tx, club.tenantId, club.userId, { email, role: 'COACH' }),
      )
    ).token;

  it('accepting makes the coach teach at every venue the club runs, without a second yes', async () => {
    const c = await coach('Иван Петров');
    const token = await invite(clubA, 'ivan@example.bg');
    const result = await runAsSuperuser((tx) => acceptInvite(tx, token, c.userId));
    expect(result).toMatchObject({ tenantId: clubA.tenantId, role: 'COACH' });

    const mine = linksOf(await myLinks(c.bearer));
    expect(mine.map((l) => [l.venue.name, l.status, l.startedBy]).sort()).toEqual([
      ['Venue A', 'ACTIVE', 'CLUB'],
      ['Venue A2', 'ACTIVE', 'CLUB'],
    ]);
    expect(await membership(clubA, c.userId)).toEqual({ role: 'COACH', status: 'ACTIVE' });
    expect((await listClubCoaches(clubA.tenantId)).map((x) => x.coach.name)).toEqual([
      'Иван Петров',
      'Иван Петров',
    ]);
    // Nothing at the other club.
    expect(await asAppUser(db, clubB.tenantId, (tx) => tx.coach.count())).toBe(0);
  });

  it('a brand-new account that accepts becomes a coach, linked but not yet approved', async () => {
    const fresh = await seedAccount(null, db);
    const token = await invite(clubA, 'new-coach@example.bg');
    await runAsSuperuser((tx) => acceptInvite(tx, token, fresh));

    const kind = await asAppSuperuser(db, (tx) =>
      tx.user.findUniqueOrThrow({ where: { id: fresh }, select: { accountKind: true } }),
    );
    expect(kind.accountKind).toBe('COACH');
    const seen = await listClubCoaches(clubA.tenantId);
    expect(seen).toHaveLength(2);
    // The club sees who it invited, and that the platform has not approved them: no text.
    expect(seen[0]!.coach).toMatchObject({ approved: false, bio: null, sports: [], slug: null });
  });

  it('an invitation overtakes a request that was waiting; a link already running is left alone', async () => {
    const c = await coach('Иван Петров');
    const waiting = linksOf(await ask(c.bearer, venueA.venueId))[0]!.id;
    const second = linksOf(await ask(c.bearer, venueA2.venueId)).find(
      (l) => l.venue.id === venueA2.venueId,
    )!.id;
    await asClub(clubA, (tx) => answerCoachRequest(tx, actor(clubA), second, true));
    await setTerms(c.bearer, second, { hourlyRateCents: 4000, lessonMinutes: [60] });

    const token = await invite(clubA, 'ivan@example.bg');
    await runAsSuperuser((tx) => acceptInvite(tx, token, c.userId));
    const mine = linksOf(await myLinks(c.bearer));
    expect(mine.find((l) => l.id === waiting)).toMatchObject({
      status: 'ACTIVE',
      startedBy: 'CLUB',
    });
    // The one that was running keeps who started it and its terms.
    expect(mine.find((l) => l.id === second)).toMatchObject({
      status: 'ACTIVE',
      startedBy: 'COACH',
      hourlyRateCents: 4000,
    });
  });

  it('a player account cannot accept a coach invitation', async () => {
    const player = await seedAccount('PLAYER', db);
    const token = await invite(clubA, 'player@example.bg');
    await expect(runAsSuperuser((tx) => acceptInvite(tx, token, player))).rejects.toMatchObject({
      name: 'InviteNeedsAnotherAccountError',
    });
    expect(await asAppSuperuser(db, (tx) => tx.coach.count())).toBe(0);
  });
});

// ─── The terms ─────────────────────────────────────────────────────────────

describe('what the coach sets at a venue', () => {
  it('rates, lengths from the courts’ own, and the cutoff; the club’s log has the change', async () => {
    const c = await teachingAtA();
    const res = await setTerms(c.bearer, c.linkId, {
      hourlyRateCents: 4000,
      groupRateCents: 6000,
      lessonMinutes: [120, 60],
      cancelCutoffHours: 12,
    });
    expect(res.status).toBe(200);
    expect(linksOf(res)[0]).toMatchObject({
      hourlyRateCents: 4000,
      groupRateCents: 6000,
      lessonMinutes: [60, 120],
      cancelCutoffHours: 12,
      // Still no hours.
      missing: ['hours'],
    });
    const changes = await asAppSuperuser(db, (tx) =>
      tx.auditEntry.findMany({
        where: { tenantId: clubA.tenantId, action: 'COACH_TERMS_CHANGED' },
        select: { actorUserId: true, detailsJson: true },
      }),
    );
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      actorUserId: c.userId,
      detailsJson: { after: { hourlyRateCents: 4000, lessonMinutes: [60, 120] } },
    });
    // The same again changes nothing and logs nothing.
    await setTerms(c.bearer, c.linkId, {
      hourlyRateCents: 4000,
      groupRateCents: 6000,
      lessonMinutes: [60, 120],
      cancelCutoffHours: 12,
    });
    expect(
      await asAppSuperuser(db, (tx) =>
        tx.auditEntry.count({ where: { action: 'COACH_TERMS_CHANGED' } }),
      ),
    ).toBe(1);
    // The club sees the terms.
    expect((await listClubCoaches(clubA.tenantId))[0]).toMatchObject({
      hourlyRateCents: 4000,
      missing: ['hours'],
    });
  });

  it('a second court booked differently widens what can be chosen, once it is for a sport the coach teaches', async () => {
    const c = await teachingAtA();
    expect(
      (await setTerms(c.bearer, c.linkId, { hourlyRateCents: 4000, lessonMinutes: [45] })).json
        .error,
    ).toMatchObject({
      code: 'VALIDATION_ERROR',
      details: { field: 'lessonMinutes', reason: 'NOT_A_COURT_LENGTH' },
    });
    await asAppSuperuser(db, (tx) =>
      tx.resource.create({
        data: {
          tenantId: clubA.tenantId,
          venueId: venueA.venueId,
          name: 'Table 1',
          sport: 'TABLE_TENNIS',
          surface: 'HARD',
          basePriceCents: 1000,
          minBookingMinutes: 45,
          maxBookingMinutes: 45,
          slotStepMinutes: 15,
        },
      }),
    );
    // A table for a sport this coach does not teach changes nothing for them:
    // a 45-minute lesson would be one no court of theirs could be booked for.
    expect(linksOf(await myLinks(c.bearer))[0]!.lengthOptions).toEqual([60, 120, 180]);
    expect(
      (await setTerms(c.bearer, c.linkId, { hourlyRateCents: 4000, lessonMinutes: [45] })).json
        .error,
    ).toMatchObject({ details: { field: 'lessonMinutes', reason: 'NOT_A_COURT_LENGTH' } });

    // Once they teach it too, its lengths are theirs to offer.
    await asAppSuperuser(db, (tx) =>
      tx.coachProfileSport.create({
        data: { userId: c.userId, sport: 'TABLE_TENNIS', levelMin: 1, levelMax: 5 },
      }),
    );
    expect(linksOf(await myLinks(c.bearer))[0]!.lengthOptions).toEqual([45, 60, 120, 180]);
    expect(
      (await setTerms(c.bearer, c.linkId, { hourlyRateCents: 4000, lessonMinutes: [45] })).status,
    ).toBe(200);
  });

  it.each([
    ['no rate', { lessonMinutes: [60] }, { field: 'hourlyRateCents', reason: 'REQUIRED' }],
    [
      'a rate that is a typo',
      { hourlyRateCents: 1_000_000, lessonMinutes: [60] },
      { field: 'hourlyRateCents', reason: 'OUT_OF_RANGE' },
    ],
    [
      'no length',
      { hourlyRateCents: 4000, lessonMinutes: [] },
      { field: 'lessonMinutes', reason: 'REQUIRED' },
    ],
    // The seeded court is booked by the hour: an hour and a half is a length
    // no booking there can have, though the court's start grid is 30 minutes.
    [
      'a length that fits the start grid but not the court’s units',
      { hourlyRateCents: 4000, lessonMinutes: [90] },
      { field: 'lessonMinutes', reason: 'NOT_A_COURT_LENGTH' },
    ],
    [
      'a cutoff over a week',
      { hourlyRateCents: 4000, lessonMinutes: [60], cancelCutoffHours: 200 },
      { field: 'cancelCutoffHours', reason: 'OUT_OF_RANGE' },
    ],
  ])('refuses %s with 400 and the field, and keeps what was there', async (_l, body, details) => {
    const c = await teachingAtA();
    const res = await setTerms(c.bearer, c.linkId, body);
    expect(res.status).toBe(400);
    expect(res.json.error).toMatchObject({ code: 'VALIDATION_ERROR', details });
    expect(linksOf(await myLinks(c.bearer))[0]!.hourlyRateCents).toBeNull();
  });

  it('only on a link the club agreed to, and only the coach’s own', async () => {
    const c = await coach('Иван Петров');
    const linkId = linksOf(await ask(c.bearer, venueA.venueId))[0]!.id;
    const TERMS = { hourlyRateCents: 4000, lessonMinutes: [60] };
    const early = await setTerms(c.bearer, linkId, TERMS);
    expect(early.status).toBe(409);
    expect(early.json.error).toMatchObject({
      code: 'COACH_LINK_STATE',
      details: { status: 'REQUESTED' },
    });
    expect((await setHours(c.bearer, linkId, [])).json.error?.code).toBe('COACH_LINK_STATE');

    // Another coach, who also teaches here, cannot touch this one's link.
    const other = await teachingAtA('Мария Илиева');
    await asClub(clubA, (tx) => answerCoachRequest(tx, actor(clubA), linkId, true));
    for (const res of [
      await setTerms(other.bearer, linkId, TERMS),
      await setHours(other.bearer, linkId, []),
      await endMine(other.bearer, linkId),
      await setTerms(c.bearer, 'cnosuchlink00000000000000', TERMS),
    ]) {
      expect(res.status).toBe(404);
      expect(res.json.error?.code).toBe('COACH_LINK_NOT_FOUND');
    }
    expect(linksOf(await myLinks(c.bearer))[0]).toMatchObject({
      status: 'ACTIVE',
      hourlyRateCents: null,
    });
  });
});

// ─── Hours and days off ────────────────────────────────────────────────────

describe('weekly hours', () => {
  it('replace the week, read back sorted, and make the link ready for lessons', async () => {
    const c = await teachingAtA();
    await setTerms(c.bearer, c.linkId, { hourlyRateCents: 4000, lessonMinutes: [60] });
    const res = await setHours(c.bearer, c.linkId, [
      { dayOfWeek: 3, open: '17:00', close: '21:00' },
      { dayOfWeek: 1, open: '09:00', close: '12:00' },
      { dayOfWeek: 1, open: '12:00', close: '13:30' },
    ]);
    expect(res.status).toBe(200);
    expect(linksOf(res)[0]).toMatchObject({
      hours: [
        { dayOfWeek: 1, open: '09:00', close: '12:00' },
        { dayOfWeek: 1, open: '12:00', close: '13:30' },
        { dayOfWeek: 3, open: '17:00', close: '21:00' },
      ],
      missing: [],
    });
    // A new week replaces it whole; an empty one clears it.
    expect(
      linksOf(
        await setHours(c.bearer, c.linkId, [{ dayOfWeek: 6, open: '10:00', close: '14:00' }]),
      )[0]!.hours,
    ).toEqual([{ dayOfWeek: 6, open: '10:00', close: '14:00' }]);
    expect(linksOf(await setHours(c.bearer, c.linkId, []))[0]).toMatchObject({
      hours: [],
      missing: ['hours'],
    });
  });

  it('a venue with no court for a sport the coach teaches: said to the coach and to the club, and no length is offered', async () => {
    const c = await teachingAtA();
    await setTerms(c.bearer, c.linkId, { hourlyRateCents: 4000, lessonMinutes: [60] });
    await setHours(c.bearer, c.linkId, [{ dayOfWeek: 1, open: '09:00', close: '12:00' }]);
    expect(linksOf(await myLinks(c.bearer))[0]).toMatchObject({ missing: [] });

    // The coach now teaches tennis only; venue A has a padel court and nothing else.
    await asAppSuperuser(db, async (tx) => {
      await tx.coachProfileSport.deleteMany({ where: { userId: c.userId } });
      await tx.coachProfileSport.create({
        data: { userId: c.userId, sport: 'TENNIS', levelMin: 1, levelMax: 5 },
      });
    });
    expect(linksOf(await myLinks(c.bearer))[0]).toMatchObject({
      lengthOptions: [],
      missing: ['courts'],
    });
    expect((await listClubCoaches(clubA.tenantId))[0]).toMatchObject({ missing: ['courts'] });

    // A tennis court that is not in use does not count; one in use does.
    const court = await asAppSuperuser(db, (tx) =>
      tx.resource.create({
        data: {
          tenantId: clubA.tenantId,
          venueId: venueA.venueId,
          name: 'Tennis 1',
          sport: 'TENNIS',
          surface: 'CLAY',
          basePriceCents: 2000,
          status: 'CLOSED',
        },
      }),
    );
    expect(linksOf(await myLinks(c.bearer))[0]!.missing).toEqual(['courts']);
    await asAppSuperuser(db, (tx) =>
      tx.resource.update({ where: { id: court.id }, data: { status: 'ACTIVE' } }),
    );
    expect(linksOf(await myLinks(c.bearer))[0]).toMatchObject({
      lengthOptions: [60, 120, 180],
      missing: [],
    });
    expect((await listClubCoaches(clubA.tenantId))[0]).toMatchObject({ missing: [] });
  });

  it.each([
    [
      'overlapping stretches',
      [
        { dayOfWeek: 1, open: '09:00', close: '12:00' },
        { dayOfWeek: 1, open: '11:00', close: '13:00' },
      ],
      'OVERLAP',
    ],
    [
      'a stretch that ends before it starts',
      [{ dayOfWeek: 1, open: '12:00', close: '09:00' }],
      'ENDS_BEFORE_IT_STARTS',
    ],
    ['a time off the quarter hour', [{ dayOfWeek: 1, open: '09:10', close: '12:00' }], 'BAD_TIME'],
    ['midnight as an end', [{ dayOfWeek: 1, open: '20:00', close: '24:00' }], 'BAD_TIME'],
  ])('refuses %s and keeps the week that was there', async (_l, hours, reason) => {
    const c = await teachingAtA();
    await setHours(c.bearer, c.linkId, [{ dayOfWeek: 2, open: '09:00', close: '10:00' }]);
    const res = await setHours(c.bearer, c.linkId, hours);
    expect(res.status).toBe(400);
    expect(res.json.error).toMatchObject({
      code: 'VALIDATION_ERROR',
      details: { field: 'hours', reason },
    });
    expect(linksOf(await myLinks(c.bearer))[0]!.hours).toEqual([
      { dayOfWeek: 2, open: '09:00', close: '10:00' },
    ]);
  });

  it('ending a link deletes its hours; the link row stays', async () => {
    const c = await teachingAtA();
    await setHours(c.bearer, c.linkId, [{ dayOfWeek: 2, open: '09:00', close: '10:00' }]);
    await endMine(c.bearer, c.linkId);
    expect(await asAppSuperuser(db, (tx) => tx.coachAvailability.count())).toBe(0);
    expect(await asAppSuperuser(db, (tx) => tx.coach.count())).toBe(1);
  });
});

describe('days off', () => {
  const today = coachToday();
  const plus = (days: number) =>
    new Date(Date.parse(`${today}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
  const list = (bearer: string) => call(timeOffGet, '/api/v1/me/coach-time-off', { bearer });
  const add = (bearer: string, json: unknown) =>
    call(timeOffPost, '/api/v1/me/coach-time-off', { method: 'POST', bearer, json });
  const remove = (bearer: string, id: string) =>
    call(timeOffDelete, `/api/v1/me/coach-time-off/${id}`, { method: 'DELETE', bearer }, { id });
  const items = (r: { json: Json }) =>
    (
      r.json.data as unknown as {
        items: Array<{ id: string; startDate: string; endDate: string; note: string | null }>;
      }
    ).items;

  it('are the coach’s own: added, listed soonest first, taken back', async () => {
    const c = await coach('Иван Петров');
    const player = await signInAs(db, { userId: await seedAccount('PLAYER', db), memberships: [] });
    expect((await list(player.bearer)).json.error?.code).toBe('COACH_ACCOUNT_REQUIRED');
    expect(items(await list(c.bearer))).toEqual([]);

    await add(c.bearer, { startDate: plus(30), endDate: plus(40), note: ' Почивка ' });
    const res = await add(c.bearer, { startDate: plus(3) });
    expect(res.status).toBe(201);
    expect(items(res).map((i) => [i.startDate, i.endDate, i.note])).toEqual([
      [plus(3), plus(3), null],
      [plus(30), plus(40), 'Почивка'],
    ]);

    // Another coach sees none of it, and cannot take it back.
    const other = await coach('Мария Илиева');
    expect(items(await list(other.bearer))).toEqual([]);
    const id = items(res)[0]!.id;
    expect((await remove(other.bearer, id)).json.error?.code).toBe('COACH_TIME_OFF_NOT_FOUND');
    expect(items(await remove(c.bearer, id)).map((i) => i.startDate)).toEqual([plus(30)]);
    // A club bound as itself reads no days off at all.
    expect(await asAppUser(db, clubA.tenantId, (tx) => tx.coachTimeOff.count())).toBe(0);
  });

  it('refuses a stretch that is over, backwards or too long, and stops at fifty', async () => {
    const c = await coach('Иван Петров');
    for (const [body, details] of [
      [
        { startDate: plus(-10), endDate: plus(-1) },
        { field: 'endDate', reason: 'IN_THE_PAST' },
      ],
      [
        { startDate: plus(5), endDate: plus(4) },
        { field: 'endDate', reason: 'ENDS_BEFORE_IT_STARTS' },
      ],
      [
        { startDate: plus(5), endDate: plus(200) },
        { field: 'endDate', reason: 'TOO_LONG' },
      ],
      [{ startDate: 'tomorrow' }, { field: 'startDate', reason: 'BAD_DATE' }],
    ] as const) {
      const res = await add(c.bearer, body);
      expect(res.status).toBe(400);
      expect(res.json.error).toMatchObject({ code: 'VALIDATION_ERROR', details });
    }
    // A stretch that has started and not ended is taken.
    expect((await add(c.bearer, { startDate: plus(-2), endDate: plus(2) })).status).toBe(201);

    await runAsUserOnly(c.userId, (tx) =>
      tx.coachTimeOff.createMany({
        data: Array.from({ length: 49 }, (_, i) => ({
          userId: c.userId,
          startDate: new Date(`${plus(10 + i)}T00:00:00Z`),
          endDate: new Date(`${plus(10 + i)}T00:00:00Z`),
        })),
      }),
    );
    const full = await add(c.bearer, { startDate: plus(100) });
    expect(full.status).toBe(409);
    expect(full.json.error?.code).toBe('COACH_TIME_OFF_LIMIT');
  });

  it('adding clears the stretches that are over', async () => {
    const c = await coach('Иван Петров');
    await runAsUserOnly(c.userId, (tx) =>
      tx.coachTimeOff.create({
        data: {
          userId: c.userId,
          startDate: new Date(`${plus(-20)}T00:00:00Z`),
          endDate: new Date(`${plus(-10)}T00:00:00Z`),
        },
      }),
    );
    expect(items(await list(c.bearer))).toEqual([]);
    await add(c.bearer, { startDate: plus(1) });
    expect(await asAppSuperuser(db, (tx) => tx.coachTimeOff.count())).toBe(1);
  });
});

// ─── What anybody else may know about a coach ──────────────────────────────

describe('the public card', () => {
  it('an approved coach’s text and sports; for anyone else the name only; nobody for an account that is gone', async () => {
    const approved = await coach('Иван Петров');
    const draft = await coach('Нов Треньор', { approved: false });
    await runAsUserOnly(draft.userId, (tx) =>
      tx.coachProfile.create({
        data: { userId: draft.userId, slug: 'nov', bio: 'Чернова, която никой не е одобрил.' },
      }),
    );
    const gone = await coach('Изтрит Треньор');
    // Deleted as an account is: scrubbed to a tombstone, the profile with it.
    await runAsSuperuser((tx) => deleteAccount(tx, { userId: gone.userId, by: 'self' }));

    const cards = await coachCards([
      approved.userId,
      draft.userId,
      gone.userId,
      'cnobody000000000000000000',
    ]);
    expect([...cards.keys()].sort()).toEqual([approved.userId, draft.userId].sort());
    expect(cards.get(approved.userId)).toMatchObject({
      approved: true,
      name: 'Иван Петров',
      qualifications: 'Лиценз ББФТ',
    });
    expect(cards.get(draft.userId)).toEqual({
      userId: draft.userId,
      name: 'Нов Треньор',
      approved: false,
      slug: null,
      bio: null,
      qualifications: null,
      sports: [],
    });
    expect(JSON.stringify([...cards.values()])).not.toContain('Чернова');
  });
});

// ─── Telling each other (#550) ─────────────────────────────────────────────

describe('a coach and a club tell each other (#550)', () => {
  const bellOf = (userId: string) =>
    asAppSuperuser(db, (tx) =>
      tx.notification.findMany({
        where: { userId },
        orderBy: { createdAt: 'asc' },
        select: { kind: true, title: true, body: true, href: true, tenantId: true },
        take: 20,
      }),
    );
  const mailOf = (userId: string) =>
    asAppSuperuser(db, (tx) =>
      tx.emailOutbox.findMany({
        where: { userId },
        orderBy: { createdAt: 'asc' },
        select: { kind: true, category: true, subject: true, text: true },
        take: 20,
      }),
    );
  /** One more person at club A, with this role. */
  async function member(role: 'MANAGER' | 'STAFF', status: 'ACTIVE' | 'SUSPENDED' = 'ACTIVE') {
    const userId = await seedAccount('CLUB', db);
    await asAppSuperuser(db, (tx) =>
      tx.tenantMembership.create({ data: { tenantId: clubA.tenantId, userId, role, status } }),
    );
    return userId;
  }
  /** What the route does after a request: ask, then tell the club. */
  async function askAndTell(bearer: string, venueId: string) {
    const res = await ask(bearer, venueId);
    expect(res.status).toBe(201);
    return linksOf(res).find((l) => l.venue.id === venueId)!.id;
  }

  it('a request reaches the club’s owners and managers, bell and email, and nobody else', async () => {
    const manager = await member('MANAGER');
    const staff = await member('STAFF');
    const suspended = await member('MANAGER', 'SUSPENDED');
    const c = await coach('Иван Петров');
    await askAndTell(c.bearer, venueA.venueId);

    const href = `/t/${clubA.tenantSlug}/admin/coaches`;
    for (const id of [clubA.userId, manager]) {
      expect(await bellOf(id)).toEqual([
        {
          kind: 'COACH_LINK_REQUESTED',
          title: 'Иван Петров иска да преподава при вас',
          body: 'Venue A. Приемете или откажете от «Треньори».',
          href,
          tenantId: clubA.tenantId,
        },
      ]);
      const [mail] = await mailOf(id);
      expect(mail).toMatchObject({ kind: 'COACH_LINK_REQUESTED', category: 'account' });
      expect(mail!.subject).toBe('Иван Петров иска да преподава в Venue A');
      expect(mail!.text).toContain(href);
    }
    // Front desk staff do not answer for the club's people; a suspended
    // manager answers for nothing; the other club hears nothing.
    for (const id of [staff, suspended, clubB.userId]) expect(await bellOf(id)).toEqual([]);
    // The coach is not told of their own act.
    expect(await bellOf(c.userId)).toEqual([]);
  });

  it('a request taken back and made again: a bell each time, but one email a day', async () => {
    const c = await coach('Иван Петров');
    const linkId = await askAndTell(c.bearer, venueA.venueId);
    expect((await endMine(c.bearer, linkId)).status).toBe(200);
    // A moment later, so the second request is its own event.
    await new Promise((r) => setTimeout(r, 5));
    await askAndTell(c.bearer, venueA.venueId);
    expect((await bellOf(clubA.userId)).map((n) => n.kind)).toEqual([
      'COACH_LINK_REQUESTED',
      'COACH_LINK_REQUESTED',
    ]);
    expect(await mailOf(clubA.userId)).toHaveLength(1);
  });

  it('accepted: the coach is told where, and to set hours and a rate', async () => {
    const c = await coach('Иван Петров');
    const linkId = await askAndTell(c.bearer, venueA.venueId);
    const change = await asClub(clubA, (tx) => answerCoachRequest(tx, actor(clubA), linkId, true));
    expect(change.event).toBe('linkAccepted');
    await notifyCoachLinkAnswered({ tenantId: clubA.tenantId, linkId, ...change });
    expect(await bellOf(c.userId)).toEqual([
      {
        kind: 'COACH_LINK_ACCEPTED',
        title: 'Venue A ви прие като треньор',
        body: expect.stringContaining('часовете и цената'),
        href: '/me/coach',
        tenantId: clubA.tenantId,
      },
    ]);
    expect((await mailOf(c.userId)).map((m) => [m.kind, m.category])).toEqual([
      ['COACH_LINK_ACCEPTED', 'account'],
    ]);
    // Run twice (a retried action), it is still one.
    await notifyCoachLinkAnswered({ tenantId: clubA.tenantId, linkId, ...change });
    expect(await bellOf(c.userId)).toHaveLength(1);
  });

  it('declined, or a request turned away by ending it: told as not accepted', async () => {
    const c = await coach('Иван Петров');
    const one = await askAndTell(c.bearer, venueA.venueId);
    const two = await askAndTell(c.bearer, venueA2.venueId);
    const declined = await asClub(clubA, (tx) => answerCoachRequest(tx, actor(clubA), one, false));
    const turnedAway = await asClub(clubA, (tx) => endCoachLink(tx, actor(clubA), two));
    expect([declined.event, turnedAway.event]).toEqual(['linkDeclined', 'linkDeclined']);
    await notifyCoachLinkAnswered({ tenantId: clubA.tenantId, linkId: one, ...declined });
    await notifyCoachLinkAnswered({ tenantId: clubA.tenantId, linkId: two, ...turnedAway });
    expect((await bellOf(c.userId)).map((n) => [n.kind, n.title])).toEqual([
      ['COACH_LINK_DECLINED', 'Venue A не прие заявката ви'],
      ['COACH_LINK_DECLINED', 'Venue A2 не прие заявката ви'],
    ]);
    expect((await mailOf(c.userId)).map((m) => m.category)).toEqual(['account', 'account']);
  });

  it('a running link ended by the club: the coach is told, and that booked lessons stay', async () => {
    const c = await teachingAtA();
    const change = await asClub(clubA, (tx) => endCoachLink(tx, actor(clubA), c.linkId));
    expect(change.event).toBe('linkEnded');
    await notifyCoachLinkAnswered({ tenantId: clubA.tenantId, linkId: c.linkId, ...change });
    expect((await bellOf(c.userId)).map((n) => [n.kind, n.title, n.body])).toEqual([
      [
        'COACH_LINK_ENDED',
        'Вече не преподавате в Venue A',
        'Клубът прекрати връзката. Вече записаните уроци остават.',
      ],
    ]);
    const [mail] = await mailOf(c.userId);
    expect(mail).toMatchObject({ kind: 'COACH_LINK_ENDED', category: 'account' });
    expect(mail!.text).toContain('/me/coach');
  });

  it('says nothing when the link has moved on before the notice ran', async () => {
    const c = await teachingAtA();
    // The acceptance's notice runs late, after the club already ended it.
    await asClub(clubA, (tx) => endCoachLink(tx, actor(clubA), c.linkId));
    await notifyCoachLinkAnswered({
      tenantId: clubA.tenantId,
      linkId: c.linkId,
      event: 'linkAccepted',
      at: new Date(),
    });
    // A request's notice that runs after it was taken back.
    const d = await coach('Петя Треньор');
    const linkId = await askAndTell(d.bearer, venueA2.venueId);
    await asAppSuperuser(db, (tx) => tx.notification.deleteMany({}));
    await endMine(d.bearer, linkId);
    await notifyCoachLinkRequested({ tenantId: clubA.tenantId, linkId, at: new Date() });
    expect(await bellOf(c.userId)).toEqual([]);
    expect(await bellOf(clubA.userId)).toEqual([]);
  });

  it('in English for an account that reads English', async () => {
    const c = await coach('Ivan Petrov');
    await asAppSuperuser(db, (tx) =>
      tx.user.update({ where: { id: clubA.userId }, data: { locale: 'en' } }),
    );
    await askAndTell(c.bearer, venueA.venueId);
    expect((await bellOf(clubA.userId)).map((n) => n.title)).toEqual([
      'Ivan Petrov asks to teach at your club',
    ]);
  });
});
