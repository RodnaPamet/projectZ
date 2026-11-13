import type { PrismaClient } from '@prisma/client';
import { NextRequest } from 'next/server';

import { recordMatch } from '@/app-layer/usecases/ratings';
import { POST as submitRoute } from '@/app/api/v1/me/skill-survey/route';
import { GET as surveyRoute } from '@/app/api/v1/skill-survey/route';
import { surveyFor } from '@/lib/ratings/skill-survey';

import { seedPlayer, signInAs, type TestIdentity } from '../helpers/auth';
import { prismaTestClient, seedTenant, type SeededTenant } from '../helpers/db';
import { asAppSuperuser } from '../helpers/rls';

/** «Вземи начално ниво» (#689): the questions, and the answers setting the declared level. */
describe('the starting-level questionnaire', () => {
  const db: PrismaClient = prismaTestClient();
  let club: SeededTenant;
  let me: TestIdentity;

  beforeEach(async () => {
    club = await seedTenant({}, db);
    me = await signInAs(db, {
      userId: await seedPlayer(db, club.tenantId, 'me'),
      memberships: [{ tenantId: club.tenantId, tenantSlug: club.tenantSlug, role: 'PLAYER' }],
    });
  });

  const ask = async (query: string, who: TestIdentity | null = me) => {
    const res = await surveyRoute(
      new NextRequest(`http://t/api/v1/skill-survey${query}`, {
        headers: who ? { authorization: `Bearer ${who.bearer}` } : {},
      }),
      { params: Promise.resolve({}) },
    );
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };

  const submit = async (body: unknown, who: TestIdentity = me) => {
    const res = await submitRoute(
      new NextRequest('http://t/api/v1/me/skill-survey', {
        method: 'POST',
        headers: { authorization: `Bearer ${who.bearer}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({}) },
    );
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };

  /** Every padel question answered with the option suggesting `level` where there is one, else the nearest. */
  const padelAnswers = (level: number) =>
    Object.fromEntries(
      surveyFor('PADEL')!.map((q) => {
        const best = [...q.options].sort(
          (a, b) => Math.abs(a.level - level) - Math.abs(b.level - level),
        )[0]!;
        return [q.id, best.id];
      }),
    );

  const declared = () =>
    asAppSuperuser(db, (tx) =>
      tx.playerSportLevel.findUnique({
        where: { userId_sport: { userId: me.userId, sport: 'PADEL' } },
      }),
    );

  it('the questions in both languages, without the levels behind the answers', async () => {
    expect((await ask('?sport=PADEL', null)).status).toBe(401);
    expect((await ask('')).status).toBe(400);
    expect((await ask('?sport=CHESS')).status).toBe(404);
    const res = await ask('?sport=PADEL');
    expect(res.status).toBe(200);
    expect(res.body.data.sports).toEqual(['TENNIS', 'PADEL']);
    expect(res.body.data.questions).toHaveLength(9);
    const first = res.body.data.questions[0];
    expect(first).toMatchObject({
      id: 'experience',
      text: { bg: expect.any(String), en: expect.any(String) },
    });
    expect(first.options[0]).toEqual({
      id: 'starting',
      text: { bg: 'Започвам сега', en: 'Just starting' },
    });
    expect(JSON.stringify(res.body)).not.toContain('"level"');
  });

  it('the answers set the declared level, and answering again replaces it', async () => {
    const first = await submit({ sport: 'PADEL', answers: padelAnswers(5) });
    expect(first.status).toBe(200);
    expect(first.body.data).toEqual({ sport: 'PADEL', level: 5 });
    expect((await declared())?.level).toBe(5);

    const again = await submit({
      sport: 'PADEL',
      answers: { ...padelAnswers(7), experience: 'starting' },
    });
    expect(again.body.data.level).toBe(2);
    expect((await declared())?.level).toBe(2);
  });

  it('every question once, with a known answer: else a 400 that changes nothing', async () => {
    const { smash: _smash, ...missing } = padelAnswers(4);
    expect((await submit({ sport: 'PADEL', answers: missing })).status).toBe(400);
    expect(
      (await submit({ sport: 'PADEL', answers: { ...padelAnswers(4), smash: 'x' } })).status,
    ).toBe(400);
    expect((await submit({ sport: 'PADEL', answers: padelAnswers(4), more: 1 })).status).toBe(400);
    expect((await submit({ sport: 'CURLINGX', answers: padelAnswers(4) })).status).toBe(400);
    expect((await submit({ sport: 'CHESS', answers: padelAnswers(4) })).status).toBe(404);
    expect(await declared()).toBeNull();
  });

  it('once a counted match has moved the rating, the questionnaire cannot (409)', async () => {
    const other = await seedPlayer(db, club.tenantId, 'other');
    await recordMatch(db, {
      tenantId: club.tenantId,
      sport: 'PADEL',
      teams: [[me.userId], [other]],
      dedupeKey: 'survey:1',
    });
    const res = await submit({ sport: 'PADEL', answers: padelAnswers(6) });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('RATING_STARTED');
    expect(await declared()).toBeNull();
  });

  it('a club account plays nothing (403)', async () => {
    // The club's owner: a CLUB account (#263), as it holds the club's OWNER role.
    await asAppSuperuser(db, (tx) =>
      tx.user.update({ where: { id: club.userId }, data: { accountKind: 'CLUB' } }),
    );
    const owner = await signInAs(db, {
      userId: club.userId,
      memberships: [{ tenantId: club.tenantId, tenantSlug: club.tenantSlug, role: 'OWNER' }],
    });
    const res = await submit({ sport: 'PADEL', answers: padelAnswers(4) }, owner);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('PLAYER_ACCOUNT_REQUIRED');
  });
});
