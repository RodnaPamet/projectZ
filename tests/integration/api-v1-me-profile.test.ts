import { NextRequest } from 'next/server';

import { GET as getMe, PATCH as patchMe } from '@/app/api/v1/me/route';
import { runAsUserOnly } from '@/lib/db/rls-middleware';
import { PROFILE_SPORTS } from '@/lib/profile/limits';

import { signInAs } from '../helpers/auth';
import { prismaTestClient, seedAccount } from '../helpers/db';
import { asAppSuperuser } from '../helpers/rls';

/**
 * PATCH /api/v1/me (#359): the display name, and the sports a player plays
 * with a self-declared level 1–7 each (Q37).
 *
 * A real database: the levels live in an owner-only RLS table (P43) written
 * through `runAsUserOnly`, and the CHECK on the level is the database's. The
 * mass-assignment cases assert both the 400 and that the row did NOT change.
 */
const db = prismaTestClient();

interface ApiError {
  error: { code: string; details?: { field?: string } };
}
interface Me {
  id: string;
  name: string | null;
  email: string;
  avatarUrl: string | null;
  accountKind: string | null;
  sports: Array<{ sport: string; level: number }>;
}

async function bearerFor(userId: string) {
  return (await signInAs(db, { userId, memberships: [] })).bearer;
}

const patch = async (bearer: string | null, body: unknown, raw = false) => {
  const res = await patchMe(
    new NextRequest('http://localhost:3000/api/v1/me', {
      method: 'PATCH',
      headers: {
        'content-type': 'application/json',
        ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      },
      body: raw ? (body as string) : JSON.stringify(body),
    }),
    { params: Promise.resolve({}) },
  );
  return { res, body: (await res.json()) as { data: Me } & ApiError };
};

const read = async (bearer: string) => {
  const res = await getMe(
    new NextRequest('http://localhost:3000/api/v1/me', {
      headers: { authorization: `Bearer ${bearer}` },
    }),
    { params: Promise.resolve({}) },
  );
  return ((await res.json()) as { data: Me }).data;
};

const userRow = (id: string) =>
  asAppSuperuser(db, (tx) => tx.user.findUniqueOrThrow({ where: { id } }));

describe('PATCH /api/v1/me (#359)', () => {
  let playerId: string;
  let bearer: string;

  beforeEach(async () => {
    playerId = await seedAccount('PLAYER');
    bearer = await bearerFor(playerId);
  });

  it('401s signed out, and writes nothing', async () => {
    const { res, body } = await patch(null, { name: 'Иван' });
    expect(res.status).toBe(401);
    expect(body.error.code).toBe('UNAUTHORIZED');
  });

  it('GET /me carries the avatar and an empty sports list for a new account', async () => {
    const me = await read(bearer);
    expect(me.avatarUrl).toBeNull();
    expect(me.sports).toEqual([]);
  });

  describe('the name', () => {
    it('sets it, trimmed and with spaces collapsed, and answers the whole account', async () => {
      const { res, body } = await patch(bearer, { name: '  Иван   Петров ' });
      expect(res.status).toBe(200);
      expect(body.data).toMatchObject({ id: playerId, name: 'Иван Петров', accountKind: 'PLAYER' });
      expect((await userRow(playerId)).name).toBe('Иван Петров');
      expect((await read(bearer)).name).toBe('Иван Петров');
    });

    it('takes names people have: Latin, hyphens, apostrophes', async () => {
      for (const name of ["Mary-Jane O'Neil", 'Анна-Мария', 'J. R. Smith']) {
        const { res, body } = await patch(bearer, { name });
        expect(res.status).toBe(200);
        expect(body.data.name).toBe(name);
      }
    });

    it.each([
      ['too short', 'И'],
      ['blank', '   '],
      ['too long', 'А'.repeat(61)],
      ['markup', '<script>x</script>'],
      ['digits only', '12345'],
      ['a control character', 'Иван\u0000'],
      ['a zero-width space', 'Иван​Петров'],
      ['not a string', 42],
      ['null', null],
    ])('refuses %s, naming the field, and keeps the old name', async (_why, name) => {
      const before = (await userRow(playerId)).name;
      const { res, body } = await patch(bearer, { name });
      expect(res.status).toBe(400);
      expect(body.error.code).toBe('BAD_REQUEST');
      expect(body.error.details?.field).toBe('name');
      expect((await userRow(playerId)).name).toBe(before);
    });
  });

  describe('sports and levels', () => {
    it('sets them, and GET answers them in the catalogue’s order', async () => {
      const { res, body } = await patch(bearer, {
        sports: [
          { sport: 'TENNIS', level: 7 },
          { sport: 'PADEL', level: 1 },
        ],
      });
      expect(res.status).toBe(200);
      expect(body.data.sports).toEqual([
        { sport: 'TENNIS', level: 7 },
        { sport: 'PADEL', level: 1 },
      ]);
      expect((await read(bearer)).sports).toEqual(body.data.sports);
    });

    it('replaces the list: a sport left out is gone, and [] clears it', async () => {
      await patch(bearer, {
        sports: [
          { sport: 'PADEL', level: 3 },
          { sport: 'TENNIS', level: 4 },
        ],
      });
      const { body } = await patch(bearer, { sports: [{ sport: 'PADEL', level: 5 }] });
      expect(body.data.sports).toEqual([{ sport: 'PADEL', level: 5 }]);
      expect((await patch(bearer, { sports: [] })).body.data.sports).toEqual([]);
    });

    it('leaves the name alone when only sports change, and the reverse', async () => {
      await patch(bearer, { name: 'Иван', sports: [{ sport: 'PADEL', level: 4 }] });
      expect((await patch(bearer, { sports: [] })).body.data.name).toBe('Иван');
      await patch(bearer, { sports: [{ sport: 'PADEL', level: 4 }] });
      expect((await patch(bearer, { name: 'Петър' })).body.data.sports).toEqual([
        { sport: 'PADEL', level: 4 },
      ]);
    });

    it.each([
      ['level 0', [{ sport: 'PADEL', level: 0 }]],
      ['level 8', [{ sport: 'PADEL', level: 8 }]],
      ['a fractional level', [{ sport: 'PADEL', level: 3.5 }]],
      ['a level as a string', [{ sport: 'PADEL', level: '3' }]],
      ['a sport not in the catalogue', [{ sport: 'SQUASH', level: 3 }]],
      ['a sport that is not booked (RUNNING)', [{ sport: 'RUNNING', level: 3 }]],
      [
        'the same sport twice',
        [
          { sport: 'PADEL', level: 3 },
          { sport: 'PADEL', level: 4 },
        ],
      ],
      ['an extra key on an entry', [{ sport: 'PADEL', level: 3, userId: 'someone' }]],
      ['not an array', { PADEL: 3 }],
    ])('refuses %s and keeps the old list', async (_why, sports) => {
      await patch(bearer, { sports: [{ sport: 'TENNIS', level: 2 }] });
      const { res, body } = await patch(bearer, { sports });
      expect(res.status).toBe(400);
      expect(body.error.details?.field).toBe('sports');
      expect((await read(bearer)).sports).toEqual([{ sport: 'TENNIS', level: 2 }]);
    });

    it('accepts every sport in the catalogue at once, at both ends of the range', async () => {
      const all = PROFILE_SPORTS.map((sport, i) => ({ sport, level: i % 2 ? 1 : 7 }));
      const { res, body } = await patch(bearer, { sports: all });
      expect(res.status).toBe(200);
      expect(body.data.sports).toHaveLength(PROFILE_SPORTS.length);
    });

    it('a CLUB account may set its name but not sports: 403 PLAYER_ACCOUNT_REQUIRED', async () => {
      const clubId = await seedAccount('CLUB');
      const clubBearer = await bearerFor(clubId);
      expect((await patch(clubBearer, { name: 'Клубът' })).res.status).toBe(200);
      const { res, body } = await patch(clubBearer, { sports: [{ sport: 'PADEL', level: 3 }] });
      expect(res.status).toBe(403);
      expect(body.error.code).toBe('PLAYER_ACCOUNT_REQUIRED');
      expect((await read(clubBearer)).sports).toEqual([]);
    });
  });

  describe('mass assignment', () => {
    it.each([
      ['email', { email: 'evil@playerz.test' }],
      ['accountKind', { accountKind: 'CLUB' }],
      ['locale', { locale: 'en' }],
      ['avatarUrl', { avatarUrl: 'https://evil.example/x.png' }],
      ['id', { id: 'someone-else' }],
      ['sessionVersion', { sessionVersion: 0 }],
      ['mfaSecret', { mfaSecret: 'x' }],
    ])('refuses %s beside a valid name, naming it, and changes nothing', async (key, extra) => {
      const before = await userRow(playerId);
      const { res, body } = await patch(bearer, { name: 'Нов', ...extra });
      expect(res.status).toBe(400);
      expect(body.error.details?.field).toBe(key);
      const after = await userRow(playerId);
      expect(after.name).toBe(before.name);
      expect(after.email).toBe(before.email);
      expect(after.accountKind).toBe(before.accountKind);
      expect(after.locale).toBe(before.locale);
      expect(after.avatarUrl).toBe(before.avatarUrl);
    });

    it('refuses an empty body, and one that is not JSON', async () => {
      expect((await patch(bearer, {})).res.status).toBe(400);
      expect((await patch(bearer, 'name=x', true)).res.status).toBe(400);
      expect((await patch(bearer, [])).res.status).toBe(400);
    });

    it("cannot reach another account's row: the id is the session's", async () => {
      const otherId = await seedAccount('PLAYER');
      await patch(bearer, { name: 'Аз', sports: [{ sport: 'PADEL', level: 6 }] });
      expect((await userRow(otherId)).name).toBe('Test PLAYER');
      const theirs = await asAppSuperuser(db, (tx) =>
        tx.playerSportLevel.findMany({ where: { userId: otherId } }),
      );
      expect(theirs).toEqual([]);
    });
  });

  describe('the table itself (P43)', () => {
    it('RLS: a person bound as themselves sees only their own levels and cannot write another’s', async () => {
      const otherId = await seedAccount('PLAYER');
      await patch(bearer, { sports: [{ sport: 'PADEL', level: 6 }] });
      await patch(await bearerFor(otherId), { sports: [{ sport: 'TENNIS', level: 2 }] });

      const seen = await runAsUserOnly(playerId, (tx) => tx.playerSportLevel.findMany(), db);
      expect(seen.map((r) => r.userId)).toEqual([playerId]);

      await expect(
        runAsUserOnly(
          playerId,
          (tx) =>
            tx.playerSportLevel.create({ data: { userId: otherId, sport: 'BADMINTON', level: 3 } }),
          db,
        ),
      ).rejects.toThrow();
      const updated = await runAsUserOnly(
        playerId,
        (tx) => tx.playerSportLevel.updateMany({ where: { userId: otherId }, data: { level: 7 } }),
        db,
      );
      expect(updated.count).toBe(0);
    });

    it('the CHECK refuses an out-of-range level even past the API', async () => {
      await expect(
        asAppSuperuser(db, (tx) =>
          tx.playerSportLevel.create({ data: { userId: playerId, sport: 'PADEL', level: 8 } }),
        ),
      ).rejects.toThrow(/player_sport_level_range/);
    });
  });
});
