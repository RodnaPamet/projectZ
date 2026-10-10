import type { PrismaClient } from '@prisma/client';
import { NextRequest } from 'next/server';

import { POST as logout } from '@/app/api/v1/auth/logout/route';
import { POST as refresh } from '@/app/api/v1/auth/refresh/route';
import { POST as token } from '@/app/api/v1/auth/token/route';
import { contextFromRequest } from '@/app/api/v1/_lib/context';
import { deleteMyAccount } from '@/app-layer/usecases/account-deletion';
import { hashPassword } from '@/lib/auth/passwords';
import { createUserSession, newSessionSecret } from '@/lib/auth/sessions';
import { runAsUserOnly } from '@/lib/db/rls-middleware';

import { prismaTestClient, seedAccount, seedTenant } from '../helpers/db';
import { asAppSuperuser, asAppUser, asAppUserAs, expectRlsIsolated } from '../helpers/rls';

/**
 * NULL-tenant rows belong to no club, so no club-bound session reaches them
 * (#488, P58).
 *
 * user_session, xp_event and match_result read `"tenantId" IS NULL OR …`, and
 * match_participant inherited it through its match. USING governs UPDATE and
 * DELETE too: any app_user session, bound to any club or to none, read every
 * session row (all of them are NULL-tenant, token hashes included) and could
 * sign a stranger out, delete their XP, or move a platform-level match into
 * its own club.
 *
 * No app_user path needs those rows: every session read and write is on
 * runAsSuperuser, and nothing in src/ binds app_user around XP or matches. So
 * all four now match the tenant and nothing else, with no `app.user_id`
 * branch: not even the row's own person reaches it as app_user.
 */
const db = prismaTestClient();
const HOUR = 3_600_000;

type Bind = <T>(fn: (tx: PrismaClient) => Promise<T>) => Promise<T>;

/** Every app_user binding that is NOT the row's club, the owner's own included. */
function strangers(owner: string, otherClub: string): Record<string, Bind> {
  return {
    'another club': (fn) => asAppUser(db, otherClub, fn),
    'another club, as the owner': (fn) => asAppUserAs(db, otherClub, owner, fn),
    // runAsUserOnly: app.user_id and no app.tenant_id, the shape a pre-tenant
    // binding would have.
    'the owner, no club': (fn) => runAsUserOnly(owner, fn, db),
    'no club, no user': (fn) =>
      db.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL ROLE app_user`);
        return fn(tx as unknown as PrismaClient);
      }),
  };
}

/** One person's platform-level rows: a session from the real sign-in function, XP, a match. */
async function platformRows() {
  const owner = await seedAccount('PLAYER', db);
  const opponent = await seedAccount('PLAYER', db);
  const { userSessionId } = await createUserSession({
    userId: owner,
    sessionSecret: newSessionSecret(),
    expiresAt: new Date(Date.now() + HOUR),
  });

  const ids = await asAppSuperuser(db, async (tx) => {
    const xp = await tx.xpEvent.create({
      data: {
        userId: owner,
        type: 'MATCH_PLAYED',
        points: 10,
        dedupeKey: `p58:${owner}`,
      },
    });
    const match = await tx.matchResultRecord.create({
      data: {
        sport: 'PADEL',
        teamsJson: [[owner], [opponent]],
        ranksJson: [1, 2],
        dedupeKey: `p58:${owner}`,
      },
    });
    const participant = await tx.matchParticipant.create({
      data: {
        matchId: match.id,
        userId: owner,
        sport: 'PADEL',
        teamIndex: 0,
        rank: 1,
        outcome: 'WIN',
      },
    });
    return { xpId: xp.id, matchId: match.id, participantId: participant.id };
  });

  return { owner, sessionId: userSessionId, ...ids };
}

type Rows = Awaited<ReturnType<typeof platformRows>>;

/** The four rows as the superuser sees them, to prove nothing moved. */
const snapshot = (r: Rows) =>
  asAppSuperuser(db, (tx) =>
    Promise.all([
      tx.userSession.findUnique({ where: { id: r.sessionId }, select: { tenantId: true } }),
      tx.xpEvent.findUnique({ where: { id: r.xpId }, select: { tenantId: true } }),
      tx.matchResultRecord.findUnique({ where: { id: r.matchId }, select: { tenantId: true } }),
      tx.matchParticipant.findUnique({
        where: { id: r.participantId },
        select: { rank: true },
      }),
    ]),
  );

describe('NULL-tenant rows and app_user (#488)', () => {
  it('the rows exist and are platform-level (the control for everything below)', async () => {
    const r = await platformRows();

    expect(await snapshot(r)).toEqual([
      { tenantId: null },
      { tenantId: null },
      { tenantId: null },
      { rank: 1 },
    ]);
  });

  it('no binding outside a club reads them, the owner included', async () => {
    const r = await platformRows();
    const club = await seedTenant({ name: 'Bystander Club' });

    const seen: Record<string, unknown> = {};
    for (const [name, bind] of Object.entries(strangers(r.owner, club.tenantId))) {
      seen[name] = await bind((tx) =>
        Promise.all([
          tx.userSession.findMany({ where: { userId: r.owner } }),
          tx.xpEvent.findMany({ where: { userId: r.owner } }),
          tx.matchResultRecord.findMany({ where: { id: r.matchId } }),
          tx.matchParticipant.findMany({ where: { matchId: r.matchId } }),
          tx.$queryRawUnsafe<Array<{ n: number }>>(
            `SELECT (SELECT count(*) FROM user_session WHERE "tenantId" IS NULL)::int
                  + (SELECT count(*) FROM xp_event WHERE "tenantId" IS NULL)::int
                  + (SELECT count(*) FROM match_result WHERE "tenantId" IS NULL)::int
                  + (SELECT count(*) FROM match_participant)::int AS n`,
          ),
        ]),
      );
    }

    const none = [[], [], [], [], [{ n: 0 }]];
    expect(seen).toEqual({
      'another club': none,
      'another club, as the owner': none,
      'the owner, no club': none,
      'no club, no user': none,
    });
  });

  it('a session bound to no club fails closed on every table', async () => {
    const r = await platformRows();

    await expectRlsIsolated(db, (tx) => tx.userSession.findMany({ where: { id: r.sessionId } }));
    await expectRlsIsolated(db, (tx) => tx.xpEvent.findMany({ where: { id: r.xpId } }));
    await expectRlsIsolated(db, (tx) =>
      tx.matchResultRecord.findMany({ where: { id: r.matchId } }),
    );
    await expectRlsIsolated(db, (tx) =>
      tx.matchParticipant.findMany({ where: { id: r.participantId } }),
    );
  });

  it('no binding outside a club deletes them or moves them into a club', async () => {
    const r = await platformRows();
    const club = await seedTenant({ name: 'Claiming Club' });

    const touched: Record<string, number[]> = {};
    for (const [name, bind] of Object.entries(strangers(r.owner, club.tenantId))) {
      touched[name] = await bind(async (tx) => [
        // Re-tenant: the new row would pass WITH CHECK for 'another club', so
        // only USING stands between it and the row.
        (
          await tx.userSession.updateMany({
            where: { id: r.sessionId },
            data: { tenantId: club.tenantId },
          })
        ).count,
        (
          await tx.matchResultRecord.updateMany({
            where: { id: r.matchId },
            data: { tenantId: club.tenantId },
          })
        ).count,
        // xp_event refuses every UPDATE by trigger, so a matched row would
        // throw here rather than count. It counts 0 because nothing matches.
        (await tx.xpEvent.updateMany({ where: { id: r.xpId }, data: { points: 0 } })).count,
        (
          await tx.matchParticipant.updateMany({
            where: { id: r.participantId },
            data: { rank: 9 },
          })
        ).count,
        // Sign out, wipe XP, erase a match.
        (await tx.userSession.deleteMany({ where: { id: r.sessionId } })).count,
        (await tx.xpEvent.deleteMany({ where: { id: r.xpId } })).count,
        (await tx.matchParticipant.deleteMany({ where: { id: r.participantId } })).count,
        (await tx.matchResultRecord.deleteMany({ where: { id: r.matchId } })).count,
      ]);
    }

    const nothing = [0, 0, 0, 0, 0, 0, 0, 0];
    expect(touched).toEqual({
      'another club': nothing,
      'another club, as the owner': nothing,
      'the owner, no club': nothing,
      'no club, no user': nothing,
    });
    expect(await snapshot(r)).toEqual([
      { tenantId: null },
      { tenantId: null },
      { tenantId: null },
      { rank: 1 },
    ]);
  });

  it('a club still reads and writes its own XP and matches, and only its own', async () => {
    const mine = await seedTenant({ name: 'Own Club' });
    const theirs = await seedTenant({ name: 'Their Club' });
    const player = await seedAccount('PLAYER', db);

    const { matchId } = await asAppUser(db, mine.tenantId, async (tx) => {
      await tx.xpEvent.create({
        data: {
          tenantId: mine.tenantId,
          userId: player,
          type: 'MATCH_PLAYED',
          points: 10,
          dedupeKey: `p58-club:${player}`,
        },
      });
      const match = await tx.matchResultRecord.create({
        data: {
          tenantId: mine.tenantId,
          sport: 'PADEL',
          teamsJson: [[player]],
          ranksJson: [1],
          dedupeKey: `p58-club:${player}`,
        },
      });
      await tx.matchParticipant.create({
        data: {
          matchId: match.id,
          userId: player,
          sport: 'PADEL',
          teamIndex: 0,
          rank: 1,
          outcome: 'WIN',
        },
      });
      return { matchId: match.id };
    });

    const read = (tenantId: string) =>
      asAppUser(db, tenantId, (tx) =>
        Promise.all([
          tx.xpEvent.count({ where: { userId: player } }),
          tx.matchResultRecord.count({ where: { id: matchId } }),
          tx.matchParticipant.count({ where: { matchId } }),
        ]),
      );
    expect(await read(mine.tenantId)).toEqual([1, 1, 1]);
    expect(await read(theirs.tenantId)).toEqual([0, 0, 0]);

    // WITH CHECK: its own row cannot be moved to another club or to none,
    await expect(
      asAppUser(db, mine.tenantId, (tx) =>
        tx.matchResultRecord.update({
          where: { id: matchId },
          data: { tenantId: theirs.tenantId },
        }),
      ),
    ).rejects.toThrow(/row-level security/i);
    await expect(
      asAppUser(db, mine.tenantId, (tx) =>
        tx.matchResultRecord.update({ where: { id: matchId }, data: { tenantId: null } }),
      ),
    ).rejects.toThrow(/row-level security/i);

    // and no NULL-tenant row is written as app_user.
    await expect(
      asAppUser(db, mine.tenantId, (tx) =>
        tx.xpEvent.create({
          data: {
            userId: player,
            type: 'MATCH_PLAYED',
            points: 10,
            dedupeKey: `p58-null:${player}`,
          },
        }),
      ),
    ).rejects.toThrow(/row-level security/i);
    await expect(
      asAppUser(db, mine.tenantId, (tx) =>
        tx.userSession.create({
          data: {
            userId: player,
            tokenHash: `p58-null:${player}`,
            expiresAt: new Date(Date.now() + HOUR),
          },
        }),
      ),
    ).rejects.toThrow(/row-level security/i);
  });
});

/**
 * The paths that DO touch these rows, end to end through the real routes. All
 * of them run on runAsSuperuser, so P58 must leave every one working.
 */
describe('the session lifecycle on a NULL-tenant session row (#488)', () => {
  const PASSWORD = 'correct horse battery staple';
  let ip = 0;

  const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
    new NextRequest(url, {
      method: 'POST',
      body: JSON.stringify(body),
      headers: {
        'content-type': 'application/json',
        // A distinct address per request: LOGIN_LIMIT is keyed on IP.
        'x-forwarded-for': `10.58.${Math.floor(ip / 250)}.${(ip++ % 250) + 1}`,
        ...headers,
      },
    });

  type Tokens = { accessToken: string; refreshToken: string };

  async function person() {
    const userId = await seedAccount('PLAYER', db);
    const email = `p58-${userId}@playerz.test`;
    const passwordHash = await hashPassword(PASSWORD);
    await asAppSuperuser(db, (tx) =>
      tx.user.update({ where: { id: userId }, data: { email, passwordHash } }),
    );
    const signIn = async (): Promise<Tokens> => {
      const res = await token(
        post('http://t/api/v1/auth/token', { email, password: PASSWORD }),
        undefined,
      );
      expect(res.status).toBe(200);
      return ((await res.json()) as { data: Tokens }).data;
    };
    return { userId, signIn };
  }

  /** Session lookup: what every authenticated request does with a Bearer token. */
  const whoIs = async (accessToken: string) =>
    (
      await contextFromRequest(
        new NextRequest('http://t/api/v1/x', {
          headers: { authorization: `Bearer ${accessToken}` },
        }),
        { slug: null, requestId: 'req_p58' },
      )
    ).userId;

  const sessionTenants = (userId: string) =>
    asAppSuperuser(db, (tx) =>
      tx.userSession.findMany({ where: { userId }, select: { tenantId: true } }),
    );

  it('sign in, look up, refresh and sign out', async () => {
    const { userId, signIn } = await person();

    const first = await signIn();
    expect(await sessionTenants(userId)).toEqual([{ tenantId: null }]);
    expect(await whoIs(first.accessToken)).toBe(userId);

    const res = await refresh(
      post('http://t/api/v1/auth/refresh', { refreshToken: first.refreshToken }),
      undefined,
    );
    expect(res.status).toBe(200);
    const next = ((await res.json()) as { data: Tokens }).data;
    expect(next.refreshToken).toEqual(expect.any(String));
    expect(next.refreshToken).not.toBe(first.refreshToken);
    expect(await whoIs(next.accessToken)).toBe(userId);

    const out = await logout(
      post('http://t/api/v1/auth/logout', {}, { authorization: `Bearer ${next.accessToken}` }),
      undefined,
    );
    expect(out.status).toBe(204);
    expect(await whoIs(next.accessToken)).toBeNull();
  });

  it('sign out everywhere ends every session of the person', async () => {
    const { userId, signIn } = await person();
    const phone = await signIn();
    const tablet = await signIn();
    expect(await whoIs(phone.accessToken)).toBe(userId);
    expect(await whoIs(tablet.accessToken)).toBe(userId);

    const out = await logout(
      post(
        'http://t/api/v1/auth/logout',
        { everywhere: true },
        { authorization: `Bearer ${phone.accessToken}` },
      ),
      undefined,
    );
    expect(out.status).toBe(204);

    expect(await whoIs(phone.accessToken)).toBeNull();
    expect(await whoIs(tablet.accessToken)).toBeNull();
  });

  it('account deletion removes the person’s sessions and platform-level XP', async () => {
    const { userId, signIn } = await person();
    await signIn();
    await asAppSuperuser(db, (tx) =>
      tx.xpEvent.create({
        data: { userId, type: 'MATCH_PLAYED', points: 10, dedupeKey: `p58-del:${userId}` },
      }),
    );

    const summary = await deleteMyAccount(userId);
    expect(summary).toBeTruthy();

    const left = await asAppSuperuser(db, (tx) =>
      Promise.all([
        tx.userSession.count({ where: { userId } }),
        tx.xpEvent.count({ where: { userId } }),
      ]),
    );
    expect(left).toEqual([0, 0]);
  });
});
