import { execFileSync } from 'node:child_process';

import { prismaTestClient, seedTenant } from '../helpers/db';
import { asAppSuperuser } from '../helpers/rls';

/**
 * ROLLING BACK PAST P51: THE PARK AND UNPARK SCRIPTS (docs/deploy-gcp.md).
 *
 * An image built before P51 cannot read SQUASH, KARTING or TRACK: Prisma 7
 * fails the whole query ("Value 'SQUASH' not found in enum 'SportType'"),
 * measured against the pre-P51 client. A test here cannot run that image, so
 * it proves the property the old image needs instead: after the park, NO
 * column of type SportType, SportType[] or ResourceType holds a value outside
 * the pre-P51 enums — and the unpark puts back exactly what was there.
 *
 * The scripts run through `prisma db execute`, as the p37 migration test runs
 * its file; production runs them through psql.
 */

const db = prismaTestClient();

const PARK = 'deploy/rollback/p51-park.sql';
const UNPARK = 'deploy/rollback/p51-unpark.sql';

function run(file: string): void {
  execFileSync('npx', ['prisma', 'db', 'execute', '--file', file], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/** What the previous image was generated with. */
const PRE_P51 = {
  SportType: [
    'TENNIS', 'PADEL', 'BADMINTON', 'TABLE_TENNIS', 'BEACH_TENNIS', 'PICKLEBALL', 'FOOTBALL5',
    'FOOTBALL', 'BASKETBALL', 'VOLLEYBALL', 'BEACH_VOLLEYBALL', 'HANDBALL', 'CHESS', 'ESPORTS',
    'RUNNING', 'CYCLING',
  ],
  ResourceType: ['COURT', 'FIELD', 'TABLE', 'BOARD_TABLE', 'LOBBY', 'ROUTE'],
}; // prettier-ignore

/** Every value any enum column holds that the previous image would refuse, by column. */
async function unreadable(): Promise<string[]> {
  const cols = await db.$queryRawUnsafe<Array<{ t: string; c: string; u: string }>>(
    `SELECT table_name AS t, column_name AS c, udt_name AS u
       FROM information_schema.columns
      WHERE table_schema = 'public' AND udt_name IN ('SportType', '_SportType', 'ResourceType')`,
  );
  expect(cols.length).toBeGreaterThanOrEqual(10);
  const out: string[] = [];
  for (const { t, c, u } of cols) {
    const known = u === 'ResourceType' ? PRE_P51.ResourceType : PRE_P51.SportType;
    const values = u.startsWith('_') ? `unnest("${c}")::text` : `"${c}"::text`;
    const rows = await db.$queryRawUnsafe<Array<{ v: string }>>(
      `SELECT DISTINCT ${values} AS v FROM "${t}"`,
    );
    for (const { v } of rows) if (v !== null && !known.includes(v)) out.push(`${t}.${c}=${v}`);
  }
  return out.sort();
}

async function parkingTables(): Promise<string[]> {
  const rows = await db.$queryRawUnsafe<Array<{ n: string }>>(
    `SELECT table_name AS n FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name LIKE 'p51_parked_%' ORDER BY 1`,
  );
  return rows.map((r) => r.n);
}

async function seed() {
  const t = await seedTenant({}, db);
  return asAppSuperuser(db, async (tx) => {
    const venue = await tx.venue.create({
      data: {
        tenantId: t.tenantId,
        slug: `park-${t.tenantId.slice(-8)}`,
        name: 'Park Venue',
        addressLine: '1 Test St',
        city: 'Sofia',
        lat: 42.6977,
        lng: 23.3219,
        email: 'park@test.invalid',
      },
      select: { id: true },
    });
    const court = (name: string, sport: never, resourceType: never, status = 'ACTIVE') =>
      tx.resource.create({
        data: {
          tenantId: t.tenantId,
          venueId: venue.id,
          name,
          sport,
          resourceType,
          status: status as never,
          surface: 'WOOD',
          basePriceCents: 1800,
        },
        select: { id: true },
      });
    const padel = await court('Падел', 'PADEL' as never, 'COURT' as never);
    const squash = await court('Скуош', 'SQUASH' as never, 'COURT' as never);
    const track = await court('Писта', 'KARTING' as never, 'TRACK' as never, 'SUSPENDED');

    const player = await tx.user.create({
      data: { email: `park-${t.tenantId.slice(-8)}@test.invalid`, accountKind: 'PLAYER' },
      select: { id: true },
    });
    await tx.playerSportLevel.createMany({
      data: [
        { userId: player.id, sport: 'PADEL', level: 5 },
        { userId: player.id, sport: 'SQUASH', level: 3 },
      ],
    });
    // A booking on the squash court: parking must leave it where it is.
    const booking = await tx.booking.create({
      data: {
        tenantId: t.tenantId,
        resourceId: squash.id,
        bookedByUserId: player.id,
        startTs: new Date('2036-11-17T07:15:00Z'),
        endTs: new Date('2036-11-17T08:00:00Z'),
        status: 'CONFIRMED',
        totalCents: 1800,
        idempotencyKey: `park-${t.tenantId}`,
      },
      select: { id: true },
    });
    return {
      padel: padel.id,
      squash: squash.id,
      track: track.id,
      player: player.id,
      booking: booking.id,
    };
  });
}

const courtRow = (id: string) =>
  db.resource.findUniqueOrThrow({
    where: { id },
    select: { sport: true, resourceType: true, status: true, name: true },
  });

const levels = (userId: string) =>
  db.playerSportLevel.findMany({
    where: { userId },
    select: { sport: true, level: true },
    orderBy: { sport: 'asc' },
  });

afterEach(async () => {
  // Not Prisma models, so the harness's TRUNCATE would never clear them.
  await db.$executeRawUnsafe('DROP TABLE IF EXISTS "p51_parked_court", "p51_parked_sport_level"');
});

describe('rolling back past P51', () => {
  it('THE POINT: after the park, the previous image can read every enum value left', async () => {
    const ids = await seed();
    expect(await unreadable()).toEqual([
      'court.resourceType=TRACK',
      'court.sport=KARTING',
      'court.sport=SQUASH',
      'player_sport_level.sport=SQUASH',
    ]);

    run(PARK);

    expect(await unreadable()).toEqual([]);
    // Squash and karting: archived, relabelled, and still named for what they are.
    expect(await courtRow(ids.squash)).toEqual({
      name: 'Скуош',
      sport: 'TENNIS',
      resourceType: 'COURT',
      status: 'CLOSED',
    });
    expect(await courtRow(ids.track)).toMatchObject({
      sport: 'TENNIS',
      resourceType: 'COURT',
      status: 'CLOSED',
    });
    // Everything else untouched, the squash booking included.
    expect(await courtRow(ids.padel)).toMatchObject({ sport: 'PADEL', status: 'ACTIVE' });
    expect(await levels(ids.player)).toEqual([{ sport: 'PADEL', level: 5 }]);
    expect(await db.booking.findUniqueOrThrow({ where: { id: ids.booking }, select: { resourceId: true } })).toEqual({ resourceId: ids.squash }); // prettier-ignore
  });

  it('a second park changes nothing, and the unpark puts back exactly what was there', async () => {
    const ids = await seed();
    run(PARK);
    run(PARK);
    expect(await unreadable()).toEqual([]);

    run(UNPARK);

    expect(await courtRow(ids.squash)).toEqual({
      name: 'Скуош',
      sport: 'SQUASH',
      resourceType: 'COURT',
      status: 'ACTIVE',
    });
    // Its own status back, not ACTIVE for everything.
    expect(await courtRow(ids.track)).toMatchObject({
      sport: 'KARTING',
      resourceType: 'TRACK',
      status: 'SUSPENDED',
    });
    expect(await levels(ids.player)).toEqual([
      { sport: 'PADEL', level: 5 },
      { sport: 'SQUASH', level: 3 },
    ]);
    expect(await parkingTables()).toEqual([]);
  });

  it('refuses, parking nothing, when another table holds a P51 value it does not handle', async () => {
    const ids = await seed();
    // Nothing writes player_profile.sports today; if something ever does, the
    // previous image fails on it, so the park must not report success.
    await asAppSuperuser(db, (tx) =>
      tx.playerProfile.create({
        data: { userId: ids.player, displayName: 'Park Player', sports: ['SQUASH' as never] },
      }),
    );

    expect(() => run(PARK)).toThrow(/p51 park: player_profile\.sports still holds 1 row/);

    // One transaction: the courts it would have parked are as they were.
    expect(await courtRow(ids.squash)).toMatchObject({ sport: 'SQUASH', status: 'ACTIVE' });
    expect(await parkingTables()).toEqual([]);
  });
});
