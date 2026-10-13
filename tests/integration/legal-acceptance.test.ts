import type { PrismaClient } from '@prisma/client';
import { NextRequest } from 'next/server';

import {
  acceptCurrentLegal,
  acceptedCurrentVersions,
  legalStanding,
} from '@/app-layer/usecases/legal-acceptance';
import { POST as chooseKindRoute } from '@/app/api/v1/me/account-kind/route';
import { GET as standingRoute, POST as acceptRoute } from '@/app/api/v1/me/legal-acceptance/route';
import { currentLegalVersions } from '@/lib/legal/versions';

import { signInAs, type TestIdentity } from '../helpers/auth';
import { prismaTestClient } from '../helpers/db';
import { asAppSuperuser } from '../helpers/rls';

/**
 * Which version of the terms and the privacy policy a person accepted (#462).
 *
 * The versions in force are a file in the build; here the file's reader is
 * replaced, so a test can publish a version and then a newer one.
 */
jest.mock('@/lib/legal/versions', () => ({
  ...jest.requireActual('@/lib/legal/versions'),
  currentLegalVersions: jest.fn(() => ({})),
}));
// The language of the request is its NEXT_LOCALE cookie, which a route called
// directly has no store for.
let cookieLocale: string | undefined;
jest.mock('@/lib/i18n/chosen-locale', () => ({ chosenLocale: async () => cookieLocale }));

const inForce = currentLegalVersions as unknown as jest.Mock;
const db = prismaTestClient();
const V1 = { terms: '2026-11-01', privacy: '2026-11-01' };

async function account(kind: 'PLAYER' | null = 'PLAYER'): Promise<TestIdentity> {
  const u = await asAppSuperuser(db, (tx) =>
    tx.user.create({
      data: {
        email: `legal-${Math.random().toString(36).slice(2)}@playerz.test`,
        accountKind: kind,
      },
      select: { id: true },
    }),
  );
  return signInAs(db, { userId: u.id, memberships: [] });
}

const rowsOf = (userId: string) =>
  asAppSuperuser(db, (tx) =>
    tx.legalAcceptance.findMany({
      where: { userId },
      select: { document: true, version: true, locale: true, acceptedAt: true },
      orderBy: [{ document: 'asc' }, { version: 'asc' }],
    }),
  );

/** As app_user bound to one person: what a route's own binding can do. */
function as<T>(userId: string, fn: (tx: PrismaClient) => Promise<T>): Promise<T> {
  return db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SELECT set_config('app.user_id', $1, true)`, userId);
    await tx.$executeRawUnsafe(`SET LOCAL ROLE app_user`);
    return fn(tx as unknown as PrismaClient);
  });
}

const call = async (
  route: typeof acceptRoute,
  method: 'GET' | 'POST',
  who: TestIdentity | null,
  path = 'legal-acceptance',
  body?: unknown,
) => {
  const res = await route(
    new NextRequest(`http://localhost:3000/api/v1/me/${path}`, {
      method,
      headers: {
        ...(body ? { 'content-type': 'application/json' } : {}),
        ...(who ? { authorization: `Bearer ${who.bearer}` } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }),
    { params: Promise.resolve({}) },
  );
  return {
    res,
    body: (await res.json()) as { data: Record<string, unknown>; error: { code: string } },
  };
};

beforeEach(() => {
  inForce.mockReturnValue(V1);
  cookieLocale = undefined;
});

describe('accepting the terms and the privacy policy (#462)', () => {
  it('records each text at the version in force, once, in the language it was read in', async () => {
    const me = await account();
    expect(await legalStanding(me.userId)).toEqual({
      current: V1,
      accepted: {},
      due: ['terms', 'privacy'],
    });

    expect(await acceptCurrentLegal(me.userId, 'en')).toEqual(V1);
    const first = await rowsOf(me.userId);
    expect(first.map((r) => [r.document, r.version, r.locale])).toEqual([
      ['privacy', '2026-11-01', 'en'],
      ['terms', '2026-11-01', 'en'],
    ]);
    expect((await legalStanding(me.userId)).due).toEqual([]);

    // Again, in another language: nothing new, and the first moment stands.
    await acceptCurrentLegal(me.userId, 'bg');
    expect(await rowsOf(me.userId)).toEqual(first);
  });

  it('a new version is due again, and the old acceptance stays on record', async () => {
    const me = await account();
    await acceptCurrentLegal(me.userId, 'bg');

    inForce.mockReturnValue({ ...V1, terms: '2027-03-01' });
    expect(await legalStanding(me.userId)).toMatchObject({
      accepted: { privacy: '2026-11-01' },
      due: ['terms'],
    });

    await acceptCurrentLegal(me.userId, 'bg');
    expect((await legalStanding(me.userId)).due).toEqual([]);
    expect((await rowsOf(me.userId)).map((r) => `${r.document}@${r.version}`)).toEqual([
      'privacy@2026-11-01',
      'terms@2026-11-01',
      'terms@2027-03-01',
    ]);

    // Back to the version they had accepted before: nothing is due, nothing is added.
    inForce.mockReturnValue(V1);
    expect((await legalStanding(me.userId)).due).toEqual([]);
  });

  it('with no version in force nothing is due, read or written', async () => {
    inForce.mockReturnValue({});
    const me = await account();
    expect(await legalStanding(me.userId)).toEqual({ current: {}, accepted: {}, due: [] });
    expect(await acceptCurrentLegal(me.userId, 'bg')).toEqual({});
    expect(await rowsOf(me.userId)).toEqual([]);
  });

  it('an unknown language is recorded as the default, never as given', async () => {
    const me = await account();
    await acceptCurrentLegal(me.userId, '<script>');
    expect((await rowsOf(me.userId)).map((r) => r.locale)).toEqual(['bg', 'bg']);
  });
});

describe('legal_acceptance in the database (P64)', () => {
  it('a person reads their own rows and nobody else’s', async () => {
    const [me, other] = await Promise.all([account(), account()]);
    await acceptCurrentLegal(me.userId, 'bg');
    await acceptCurrentLegal(other.userId, 'bg');

    const seen = await as(me.userId, (tx) =>
      tx.legalAcceptance.findMany({ select: { userId: true } }),
    );
    expect(new Set(seen.map((r) => r.userId))).toEqual(new Set([me.userId]));
    expect(await acceptedCurrentVersions(other.userId)).toEqual(V1);
  });

  it('bound to a person, a row cannot be written for somebody else', async () => {
    const [me, other] = await Promise.all([account(), account()]);
    await expect(
      as(me.userId, (tx) =>
        tx.legalAcceptance.create({
          data: { userId: other.userId, document: 'terms', version: 'x1', locale: 'bg' },
        }),
      ),
    ).rejects.toThrow();
    expect(await rowsOf(other.userId)).toEqual([]);
  });

  it('bound to a person, an acceptance is neither changed nor withdrawn', async () => {
    const me = await account();
    await acceptCurrentLegal(me.userId, 'bg');
    await expect(
      as(me.userId, (tx) =>
        tx.legalAcceptance.updateMany({
          where: { userId: me.userId },
          data: { version: 'edited' },
        }),
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      as(me.userId, (tx) => tx.legalAcceptance.deleteMany({ where: { userId: me.userId } })),
    ).rejects.toThrow(/permission denied/);
    expect(await rowsOf(me.userId)).toHaveLength(2);
  });

  it('only the terms and the privacy policy, at a well-formed version', async () => {
    const me = await account();
    for (const bad of [
      { document: 'cookies', version: '2026-11-01' },
      { document: 'terms', version: '' },
      { document: 'terms', version: 'two words' },
    ]) {
      await expect(
        asAppSuperuser(db, (tx) =>
          tx.legalAcceptance.create({ data: { userId: me.userId, locale: 'bg', ...bad } }),
        ),
      ).rejects.toThrow();
    }
  });

  it('a deleted account accepts nothing', async () => {
    const me = await account();
    await asAppSuperuser(db, (tx) =>
      tx.user.update({
        where: { id: me.userId },
        data: {
          deletedAt: new Date(),
          email: `deleted-${me.userId}@deleted.playerz.invalid`,
          name: null,
        },
      }),
    );
    await expect(acceptCurrentLegal(me.userId, 'bg')).rejects.toThrow(/account_deleted/);
    expect(await rowsOf(me.userId)).toEqual([]);
  });
});

describe('GET and POST /api/v1/me/legal-acceptance (#462)', () => {
  it('needs a session', async () => {
    expect((await call(standingRoute, 'GET', null)).res.status).toBe(401);
    expect((await call(acceptRoute, 'POST', null)).res.status).toBe(401);
  });

  it('GET says what is in force and what is due; POST accepts it, in the request’s language', async () => {
    const me = await account();
    const before = await call(standingRoute, 'GET', me);
    expect(before.res.status).toBe(200);
    expect(before.body.data).toEqual({ current: V1, accepted: {}, due: ['terms', 'privacy'] });

    cookieLocale = 'en';
    const done = await call(acceptRoute, 'POST', me);
    expect(done.res.status).toBe(200);
    expect(done.body.data).toEqual({ current: V1, accepted: V1, due: [] });
    expect((await rowsOf(me.userId)).map((r) => r.locale)).toEqual(['en', 'en']);

    // Repeating it is not an error and adds nothing.
    expect((await call(acceptRoute, 'POST', me)).res.status).toBe(200);
    expect(await rowsOf(me.userId)).toHaveLength(2);
  });
});

describe('the first-sign-in screen records what its line says (#462)', () => {
  const choose = (who: TestIdentity) =>
    call(chooseKindRoute as typeof acceptRoute, 'POST', who, 'account-kind', { kind: 'PLAYER' });

  it('with both texts in force, choosing a kind accepts both', async () => {
    const me = await account(null);
    expect((await choose(me)).res.status).toBe(200);
    expect((await legalStanding(me.userId)).due).toEqual([]);
    expect(await rowsOf(me.userId)).toHaveLength(2);
  });

  it('with only one in force the line was not shown, so nothing is recorded there', async () => {
    inForce.mockReturnValue({ privacy: '2026-11-01' });
    const me = await account(null);
    expect((await choose(me)).res.status).toBe(200);
    expect(await rowsOf(me.userId)).toEqual([]);
    expect((await legalStanding(me.userId)).due).toEqual(['privacy']);
  });

  it('with none in force, choosing a kind is what it was', async () => {
    inForce.mockReturnValue({});
    const me = await account(null);
    expect((await choose(me)).res.status).toBe(200);
    expect(await rowsOf(me.userId)).toEqual([]);
  });
});
