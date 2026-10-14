import type { PrismaClient } from '@prisma/client';

import { currentRating, playerStats, recordMatch } from '@/app-layer/usecases/ratings';
import { totalXpFor } from '@/app-layer/usecases/gamification';
import { pgErrorCode } from '@/lib/db/pg-errors';
import { closeRedis, redis } from '@/lib/redis';

import { prismaTestClient, seedTenant, type SeededTenant } from '../helpers/db';
import { asAppSuperuser } from '../helpers/rls';

let db: PrismaClient;
let tenant: SeededTenant;

beforeAll(() => {
  db = prismaTestClient();
});

beforeEach(async () => {
  tenant = await seedTenant();
  await redis().flushdb();
});

afterAll(async () => {
  await closeRedis();
});

async function seedUsers(n: number): Promise<string[]> {
  return asAppSuperuser(db, (tx) =>
    Promise.all(
      Array.from({ length: n }, (_, i) =>
        tx.user
          .create({
            data: { email: `p${i}-${Math.random().toString(36).slice(2, 8)}@playerz.test` },
          })
          .then((u) => u.id),
      ),
    ),
  );
}

// ══ Idempotency ══════════════════════════════════════════════════════

describe('a match is rated exactly ONCE', () => {
  it('re-reporting a result does not move ratings a second time', async () => {
    // A rating update is NOT reversible by subtraction. Applying the same match
    // twice feeds the second update a mu and sigma that already contain the
    // first, producing a rating no sequence of real matches could have made —
    // and the only way back is replaying the player's entire history.
    const [a, b, c, d] = await seedUsers(4);

    const first = await recordMatch(db, {
      tenantId: tenant.tenantId,
      sport: 'PADEL',
      teams: [
        [a!, b!],
        [c!, d!],
      ],
      dedupeKey: 'session:sess_1',
    });

    expect(first.recorded).toBe(true);
    const afterFirst = await currentRating(db, a!, 'PADEL');

    const second = await recordMatch(db, {
      tenantId: tenant.tenantId,
      sport: 'PADEL',
      teams: [
        [a!, b!],
        [c!, d!],
      ],
      dedupeKey: 'session:sess_1',
    });

    expect(second.recorded).toBe(false);

    const afterSecond = await currentRating(db, a!, 'PADEL');
    expect(afterSecond.state.mu).toBe(afterFirst.state.mu);

    // Exactly one history row per player.
    expect(await db.skillRatingHistory.count({ where: { userId: a! } })).toBe(1);
  });

  it('CONCURRENT reports of the same match rate it once', async () => {
    const [a, b] = await seedUsers(2);

    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        recordMatch(db, {
          tenantId: tenant.tenantId,
          sport: 'CHESS',
          teams: [[a!], [b!]],
          dedupeKey: 'game:g_race',
        }).catch(() => ({ recorded: false, ratings: new Map() })),
      ),
    );

    expect(results.filter((r) => r.recorded)).toHaveLength(1);
    expect(await db.skillRatingHistory.count({ where: { userId: a! } })).toBe(1);
  });

  it('the DATABASE refuses a duplicate dedupeKey', async () => {
    const [a, b] = await seedUsers(2);

    await recordMatch(db, {
      tenantId: tenant.tenantId,
      sport: 'PADEL',
      teams: [[a!], [b!]],
      dedupeKey: 'session:dup',
    });

    const raw = asAppSuperuser(db, (tx) =>
      tx.matchResultRecord.create({
        data: {
          tenantId: tenant.tenantId,
          sport: 'PADEL',
          teamsJson: [[a!], [b!]],
          ranksJson: [1, 2],
          dedupeKey: 'session:dup',
        },
      }),
    );

    await expect(raw.catch((e) => pgErrorCode(e))).resolves.toBe('23505');
  });

  it('a player cannot be on both sides of their own match', async () => {
    const [a, b] = await seedUsers(2);

    await expect(
      recordMatch(db, {
        tenantId: tenant.tenantId,
        sport: 'PADEL',
        teams: [
          [a!, b!],
          [a!, b!],
        ],
        dedupeKey: 'session:self',
      }),
    ).rejects.toThrow(/cannot appear twice/);
  });
});

// ══ Two engines, one table ═══════════════════════════════════════════

describe('the two engines coexist without contaminating each other', () => {
  it('a padel result writes an OPENSKILL row with NO phi', async () => {
    const [a, b] = await seedUsers(2);

    await recordMatch(db, {
      tenantId: tenant.tenantId,
      sport: 'PADEL',
      teams: [[a!], [b!]],
      dedupeKey: 'session:p1',
    });

    const row = await db.skillRatingHistory.findFirstOrThrow({ where: { userId: a! } });

    expect(row.engine).toBe('OPENSKILL');
    // NOT 0. A zero would read as "perfectly certain" — the opposite of what a
    // missing value means.
    expect(row.phi).toBeNull();
    expect(Number(row.mu)).toBeGreaterThan(25);
  });

  it('a chess result writes a GLICKO2 row WITH a phi, on the 1500 scale', async () => {
    const [a, b] = await seedUsers(2);

    await recordMatch(db, {
      tenantId: tenant.tenantId,
      sport: 'CHESS',
      teams: [[a!], [b!]],
      dedupeKey: 'game:c1',
    });

    const row = await db.skillRatingHistory.findFirstOrThrow({ where: { userId: a! } });

    expect(row.engine).toBe('GLICKO2');
    expect(row.phi).not.toBeNull();
    expect(Number(row.mu)).toBeGreaterThan(1500);
  });

  it('the DATABASE refuses a Glicko row with no phi', async () => {
    // The CHECK constraint. A Glicko row without phi is uninterpretable — you
    // cannot say how confident the rating is, which is half of what Glicko is.
    const [a] = await seedUsers(1);

    const attempt = asAppSuperuser(db, (tx) =>
      tx.skillRatingHistory.create({
        data: {
          userId: a!,
          sport: 'CHESS',
          engine: 'GLICKO2',
          mu: 1500,
          phi: null,
          sigma: 0.06,
          displayRating: 800,
        },
      }),
    );

    await expect(attempt.catch((e) => pgErrorCode(e))).resolves.toBe('23514');
  });

  it('the DATABASE refuses an openskill row that carries a phi', async () => {
    // Someone wrote the wrong shape into the row. openskill has no phi at all.
    const [a] = await seedUsers(1);

    const attempt = asAppSuperuser(db, (tx) =>
      tx.skillRatingHistory.create({
        data: {
          userId: a!,
          sport: 'PADEL',
          engine: 'OPENSKILL',
          mu: 25,
          phi: 350,
          sigma: 8.333,
          displayRating: 0,
        },
      }),
    );

    await expect(attempt.catch((e) => pgErrorCode(e))).resolves.toBe('23514');
  });

  it("a player's chess and padel ratings are entirely independent", async () => {
    // They are on different scales and must never influence one another.
    const [a, b] = await seedUsers(2);

    await recordMatch(db, {
      tenantId: tenant.tenantId,
      sport: 'CHESS',
      teams: [[a!], [b!]],
      dedupeKey: 'game:x1',
    });

    const padel = await currentRating(db, a!, 'PADEL');

    // Winning at chess does not make you good at padel.
    expect(padel.engine).toBe('OPENSKILL');
    expect(padel.state.mu).toBeCloseTo(25, 0);
  });
});

// ══ Ratings actually move ════════════════════════════════════════════

describe('ratings move in the right direction', () => {
  it('winners rise and losers fall', async () => {
    const [a, b, c, d] = await seedUsers(4);

    const { ratings } = await recordMatch(db, {
      tenantId: tenant.tenantId,
      sport: 'PADEL',
      teams: [
        [a!, b!],
        [c!, d!],
      ],
      dedupeKey: 'session:move',
    });

    expect(ratings.get(a!)!.after).toBeGreaterThan(ratings.get(a!)!.before);
    expect(ratings.get(c!)!.after).toBeLessThan(ratings.get(c!)!.before);
  });

  it('matchesPlayed increments once per match, for both engines', async () => {
    const [a, b] = await seedUsers(2);

    for (const i of [1, 2, 3]) {
      await recordMatch(db, {
        tenantId: tenant.tenantId,
        sport: 'PADEL',
        teams: [[a!], [b!]],
        dedupeKey: `session:count_${i}`,
      });
    }

    const latest = await db.skillRatingHistory.findFirstOrThrow({
      where: { userId: a!, sport: 'PADEL' },
      orderBy: { computedAt: 'desc' },
    });

    expect(latest.matchesPlayed).toBe(3);
  });

  it('playing a match awards XP — once', async () => {
    const [a, b] = await seedUsers(2);

    await recordMatch(db, {
      tenantId: tenant.tenantId,
      sport: 'PADEL',
      teams: [[a!], [b!]],
      dedupeKey: 'session:xp',
    });
    await recordMatch(db, {
      tenantId: tenant.tenantId,
      sport: 'PADEL',
      teams: [[a!], [b!]],
      dedupeKey: 'session:xp',
    });

    expect(await totalXpFor(db, a!)).toBe(30); // MATCH_PLAYED, not 60
  });
});

// ══ The dashboard ════════════════════════════════════════════════════

describe('the performance dashboard', () => {
  it('counts wins, losses and draws — and a DRAW is not a win', async () => {
    // Treating a shared first place as a win would inflate the win rate of
    // every player in a sport where draws are common, which in a country that
    // plays a lot of football is most of them.
    const [a, b] = await seedUsers(2);

    await recordMatch(db, {
      tenantId: tenant.tenantId,
      sport: 'PADEL',
      teams: [[a!], [b!]],
      dedupeKey: 's:w1',
    });
    await recordMatch(db, {
      tenantId: tenant.tenantId,
      sport: 'PADEL',
      teams: [[b!], [a!]],
      dedupeKey: 's:l1',
    });
    await recordMatch(db, {
      tenantId: tenant.tenantId,
      sport: 'PADEL',
      teams: [[a!], [b!]],
      ranks: [1, 1], // a draw
      dedupeKey: 's:d1',
    });

    const stats = await playerStats(db, { userId: a!, sport: 'PADEL' });

    expect(stats.wins).toBe(1);
    expect(stats.losses).toBe(1);
    expect(stats.draws).toBe(1);
    expect(stats.matchesPlayed).toBe(3);

    // Draws are in the DENOMINATOR. 1 win in 3 is 33.3%, not 50%.
    expect(stats.winRate).toBeCloseTo(33.3, 1);
  });

  it('returns a trend oldest-first, for a sparkline', async () => {
    const [a, b] = await seedUsers(2);

    for (const i of [1, 2, 3]) {
      await recordMatch(db, {
        tenantId: tenant.tenantId,
        sport: 'PADEL',
        teams: [[a!], [b!]],
        dedupeKey: `s:t${i}`,
      });
    }

    const stats = await playerStats(db, { userId: a!, sport: 'PADEL' });

    expect(stats.trend).toHaveLength(3);
    // Oldest → newest. A chart drawn from a descending list runs backwards, and
    // an improving player appears to be getting worse.
    for (let i = 1; i < stats.trend.length; i++) {
      expect(stats.trend[i]!.at.getTime()).toBeGreaterThanOrEqual(stats.trend[i - 1]!.at.getTime());
    }
    // Three straight wins → the rating climbs.
    expect(stats.trend[2]!.rating).toBeGreaterThan(stats.trend[0]!.rating);
  });

  it("a player's record is THEIRS — not whatever fell inside a global window", async () => {
    // The bug this table exists to prevent.
    //
    // The first version scanned the 500 most recent matches GLOBALLY and looked
    // for the player in them. That is not merely slow: any bound on that fetch
    // (and there must be one) silently truncates a player's history to whichever
    // matches happened to be in the window. On a busy platform, a player who
    // plays weekly would be told they have no record at all.
    //
    // Here: two players record one match, then a crowd of others floods the
    // sport with more recent ones. The original player's record must survive.
    const [a, b] = await seedUsers(2);

    await recordMatch(db, {
      tenantId: tenant.tenantId,
      sport: 'PADEL',
      teams: [[a!], [b!]],
      dedupeKey: 'session:mine',
    });

    const crowd = await seedUsers(20);
    for (let i = 0; i < 10; i++) {
      await recordMatch(db, {
        tenantId: tenant.tenantId,
        sport: 'PADEL',
        teams: [[crowd[i * 2]!], [crowd[i * 2 + 1]!]],
        dedupeKey: `session:noise_${i}`,
      });
    }

    const stats = await playerStats(db, { userId: a!, sport: 'PADEL' });

    // Their one win is still there, buried under ten more recent matches.
    expect(stats.wins).toBe(1);
    expect(stats.matchesPlayed).toBe(1);
    // 20 users and 11 matches is genuinely a lot of round trips, and coverage
    // instrumentation roughly doubles the time. The default 5s makes this test
    // FLAKY under `--coverage` — and a test that fails at random is worse than no
    // test, because it teaches people to re-run the build instead of reading it.
  }, 30_000);

  it('an unplayed sport reports a fresh rating and a zero record, not a crash', async () => {
    const [a] = await seedUsers(1);

    const stats = await playerStats(db, { userId: a!, sport: 'BADMINTON' });

    expect(stats.matchesPlayed).toBe(0);
    expect(stats.winRate).toBe(0);
    expect(stats.trend).toEqual([]);
    expect(stats.engine).toBe('OPENSKILL');
  });
});

describe('a first rating starts at the declared level (#378, Q24)', () => {
  it('a player who said 6 at padel starts there, one who said nothing in the middle', async () => {
    const [declared, silent] = await seedUsers(2);
    await asAppSuperuser(db, (tx) =>
      tx.playerSportLevel.create({ data: { userId: declared!, sport: 'PADEL', level: 6 } }),
    );

    const [a, b] = await Promise.all([
      currentRating(db, declared!, 'PADEL'),
      currentRating(db, silent!, 'PADEL'),
    ]);

    expect(a.state.mu).toBe(33);
    expect(b.state.mu).toBe(25);
    // The same uncertainty: the claim decides where they start, not how sure.
    expect(a.state.sigma).toBe(b.state.sigma);
  });

  it('the first result moves from the declared level, and the next ones from the history', async () => {
    const [strong, weak] = await seedUsers(2);
    await asAppSuperuser(db, (tx) =>
      tx.playerSportLevel.createMany({
        data: [
          { userId: strong!, sport: 'TENNIS', level: 7 },
          { userId: weak!, sport: 'TENNIS', level: 1 },
        ],
      }),
    );
    // The weak player beats the strong one: a large upset moves both a lot.
    await recordMatch(db, {
      tenantId: tenant.tenantId,
      sport: 'TENNIS',
      teams: [[weak!], [strong!]],
      dedupeKey: `seed-test:${weak}:${strong}`,
    });
    const [w, s] = await Promise.all([
      currentRating(db, weak!, 'TENNIS'),
      currentRating(db, strong!, 'TENNIS'),
    ]);
    expect(w.state.mu).toBeGreaterThan(13);
    expect(s.state.mu).toBeLessThan(37);
  });
});
