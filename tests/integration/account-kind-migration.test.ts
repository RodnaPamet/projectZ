import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

import type { PrismaClient, Role } from '@prisma/client';

import { prismaTestClient, seedTenant, type SeededTenant } from '../helpers/db';
import { asAppSuperuser } from '../helpers/rls';

/**
 * "CLUB SIDE WINS" — THE p37 MIGRATION, ON FIXTURE DATA SHAPED LIKE BEFORE IT.
 *
 * The migration decides every existing account from what it held (#263):
 *
 *   one club role, no coach role   → CLUB, and its ACTIVE player memberships
 *                                     EXPIRE — rows and bookings kept
 *   club roles at two or more clubs → NULL, untouched: a person decides
 *   any coach role                  → NULL, untouched: only the coach flow
 *                                     makes a COACH account
 *   anything else                   → PLAYER
 *
 * ═══ HOW THE "BEFORE" IS BUILT ═══
 *
 * The test database is already migrated, and the trigger p37 installs refuses
 * exactly the mixed accounts this needs. So the fixtures are written with
 * triggers off — `session_replication_role = replica`, in one transaction —
 * and every account as PLAYER, which is what the column default gave every
 * row before the data statements ran. `lastContext` is put back for the same
 * reason: the migration drops it.
 *
 * Then the REAL migration file is run, through `prisma db execute` — the same
 * engine path `migrate deploy` uses — TWICE, because it must be idempotent: a
 * deploy that dies half-way is retried by running it again.
 */

const MIGRATION = 'prisma/migrations/20260929190000_p37_account_kinds/migration.sql';

const db = prismaTestClient();

function runMigration(): void {
  execFileSync('npx', ['prisma', 'db', 'execute', '--file', MIGRATION], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

interface Fixture {
  a: SeededTenant;
  b: SeededTenant;
  c: SeededTenant;
  ids: Record<string, string>;
  bookingId: string;
}

/** Everything written with triggers OFF, every account PLAYER — the shape before p37. */
async function beforeTheMigration(): Promise<Fixture> {
  const a = await seedTenant({ name: 'Club A' });
  const b = await seedTenant({ name: 'Club B' });
  const c = await seedTenant({ name: 'Club C' });

  return db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica');
    await tx.$executeRawUnsafe(
      `ALTER TABLE "app_user" ADD COLUMN IF NOT EXISTS "lastContext" TEXT`,
    );
    // The seeded owners were created as CLUB; before p37 there was no kind.
    await tx.$executeRawUnsafe(`UPDATE "app_user" SET "accountKind" = 'PLAYER'`);

    const ids: Record<string, string> = {};
    const person = async (label: string, holds: Array<[SeededTenant, Role, string?]>) => {
      const u = await tx.user.create({
        data: { email: `${label}-${randomUUID().slice(0, 8)}@before.test`, accountKind: 'PLAYER' },
        select: { id: true },
      });
      for (const [club, role, status] of holds) {
        await tx.tenantMembership.create({
          data: {
            userId: u.id,
            tenantId: club.tenantId,
            role,
            status: (status ?? 'ACTIVE') as never,
          },
        });
      }
      ids[label] = u.id;
    };

    await person('player', [
      [a, 'PLAYER'],
      [b, 'PLAYER'],
    ]);
    await person('owner', [
      [a, 'OWNER'],
      [b, 'PLAYER'],
      [c, 'PLAYER'],
    ]);
    await person('manager', [
      [b, 'MANAGER'],
      [a, 'PLAYER', 'SUSPENDED'],
    ]);
    await person('multiClub', [
      [a, 'OWNER'],
      [b, 'STAFF'],
      [c, 'PLAYER'],
    ]);
    await person('coachAndClub', [
      [a, 'COACH'],
      [b, 'MANAGER'],
    ]);
    await person('coachOnly', [
      [a, 'COACH'],
      [b, 'PLAYER'],
    ]);
    await person('formerStaff', [
      [a, 'STAFF', 'SUSPENDED'],
      [b, 'PLAYER'],
    ]);
    await person('nobody', []);

    // A booking the owner made as a player at club B — it must survive.
    const venue = await tx.venue.create({
      data: {
        tenantId: b.tenantId,
        slug: `before-${randomUUID().slice(0, 8)}`,
        name: 'Before',
        addressLine: '1 St',
        city: 'Sofia',
        email: 'b@before.test',
        lat: 42.69,
        lng: 23.32,
      },
    });
    const court = await tx.resource.create({
      data: {
        tenantId: b.tenantId,
        venueId: venue.id,
        name: 'Court 1',
        sport: 'PADEL',
        surface: 'HARD',
        basePriceCents: 2400,
      },
    });
    const booking = await tx.booking.create({
      data: {
        tenantId: b.tenantId,
        resourceId: court.id,
        bookedByUserId: ids.owner!,
        startTs: new Date('2026-11-04T08:00:00Z'),
        endTs: new Date('2026-11-04T09:00:00Z'),
        status: 'CONFIRMED',
        totalCents: 2400,
        idempotencyKey: `before-${randomUUID()}`,
      },
      select: { id: true },
    });

    return { a, b, c, ids, bookingId: booking.id };
  });
}

type Snapshot = Array<{
  label: string;
  kind: string | null;
  memberships: Array<{ club: string; role: string; status: string; deactivated: boolean }>;
}>;

async function snapshot(f: Fixture): Promise<Snapshot> {
  const clubName = new Map([
    [f.a.tenantId, 'A'],
    [f.b.tenantId, 'B'],
    [f.c.tenantId, 'C'],
  ]);

  return asAppSuperuser(db, async (tx: PrismaClient) =>
    Promise.all(
      Object.entries(f.ids).map(async ([label, id]) => {
        const user = await tx.user.findUniqueOrThrow({
          where: { id },
          select: { accountKind: true },
        });
        const rows = await tx.tenantMembership.findMany({
          where: { userId: id },
          select: { tenantId: true, role: true, status: true, deactivatedAt: true },
        });
        return {
          label,
          kind: user.accountKind,
          memberships: rows
            .map((m) => ({
              club: clubName.get(m.tenantId) ?? '?',
              role: m.role,
              status: m.status,
              deactivated: m.deactivatedAt !== null,
            }))
            .sort((x, y) => x.club.localeCompare(y.club)),
        };
      }),
    ),
  );
}

const of = (s: Snapshot, label: string) => s.find((r) => r.label === label)!;

describe('the p37 migration: club side wins', () => {
  let f: Fixture;
  let after: Snapshot;

  beforeEach(async () => {
    f = await beforeTheMigration();
    runMigration();
    after = await snapshot(f);
  });

  it('a club role at ONE club makes a CLUB account, and its player memberships EXPIRE', async () => {
    expect(of(after, 'owner')).toEqual({
      label: 'owner',
      kind: 'CLUB',
      memberships: [
        { club: 'A', role: 'OWNER', status: 'ACTIVE', deactivated: false },
        { club: 'B', role: 'PLAYER', status: 'EXPIRED', deactivated: true },
        { club: 'C', role: 'PLAYER', status: 'EXPIRED', deactivated: true },
      ],
    });
  });

  it('…and its bookings are kept, with the club they were made at', async () => {
    const booking = await asAppSuperuser(db, (tx) =>
      tx.booking.findUniqueOrThrow({
        where: { id: f.bookingId },
        select: { status: true, bookedByUserId: true, tenantId: true },
      }),
    );

    expect(booking).toEqual({
      status: 'CONFIRMED',
      bookedByUserId: f.ids.owner,
      tenantId: f.b.tenantId,
    });
  });

  it('a player membership that was already suspended is left as it was', async () => {
    expect(of(after, 'manager')).toEqual({
      label: 'manager',
      kind: 'CLUB',
      memberships: [
        { club: 'A', role: 'PLAYER', status: 'SUSPENDED', deactivated: false },
        { club: 'B', role: 'MANAGER', status: 'ACTIVE', deactivated: false },
      ],
    });
  });

  it('club roles at TWO clubs are NOT decided: kind NULL, every membership untouched', async () => {
    expect(of(after, 'multiClub')).toEqual({
      label: 'multiClub',
      kind: null,
      memberships: [
        { club: 'A', role: 'OWNER', status: 'ACTIVE', deactivated: false },
        { club: 'B', role: 'STAFF', status: 'ACTIVE', deactivated: false },
        { club: 'C', role: 'PLAYER', status: 'ACTIVE', deactivated: false },
      ],
    });
  });

  it('a COACH role beside a club role is NOT decided either', async () => {
    expect(of(after, 'coachAndClub')).toMatchObject({
      kind: null,
      memberships: [
        { club: 'A', role: 'COACH', status: 'ACTIVE' },
        { club: 'B', role: 'MANAGER', status: 'ACTIVE' },
      ],
    });
  });

  it('nor is a COACH role alone — only the coach flow makes a COACH account', async () => {
    expect(of(after, 'coachOnly')).toMatchObject({
      kind: null,
      memberships: [
        { club: 'A', role: 'COACH', status: 'ACTIVE' },
        { club: 'B', role: 'PLAYER', status: 'ACTIVE' },
      ],
    });
  });

  it('players, former staff and empty accounts stay PLAYER, untouched', async () => {
    expect(of(after, 'player')).toMatchObject({
      kind: 'PLAYER',
      memberships: [
        { club: 'A', role: 'PLAYER', status: 'ACTIVE' },
        { club: 'B', role: 'PLAYER', status: 'ACTIVE' },
      ],
    });
    // A suspended club role is history, not a role held.
    expect(of(after, 'formerStaff')).toMatchObject({
      kind: 'PLAYER',
      memberships: [
        { club: 'A', role: 'STAFF', status: 'SUSPENDED' },
        { club: 'B', role: 'PLAYER', status: 'ACTIVE' },
      ],
    });
    expect(of(after, 'nobody')).toEqual({ label: 'nobody', kind: 'PLAYER', memberships: [] });
  });

  it('drops the switcher’s lastContext column', async () => {
    const columns = await asAppSuperuser(db, (tx) =>
      tx.$queryRawUnsafe<Array<{ column_name: string }>>(
        `SELECT column_name FROM information_schema.columns
          WHERE table_name = 'app_user' AND column_name = 'lastContext'`,
      ),
    );
    expect(columns).toEqual([]);
  });

  it('is IDEMPOTENT: a second run over its own result changes nothing', async () => {
    const stamps = () =>
      asAppSuperuser(db, (tx) =>
        tx.tenantMembership.findMany({
          where: { userId: { in: Object.values(f.ids) } },
          select: { id: true, status: true, deactivatedAt: true, updatedAt: true },
          orderBy: { id: 'asc' },
        }),
      );
    const before = await stamps();

    runMigration();

    expect(await snapshot(f)).toEqual(after);
    // Not even a timestamp moves: the rows it expired are no longer ACTIVE,
    // so the second run does not select them again.
    expect(await stamps()).toEqual(before);
  });

  it('the report lists exactly the three it would not decide, and why', async () => {
    const out = execFileSync('npx', ['tsx', 'scripts/report-undecided-accounts.ts', '--json'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const report = JSON.parse(out) as {
      undecided: number;
      accounts: Array<{ userId: string; reason: string; accountKind: string | null }>;
    };

    expect(report.undecided).toBe(3);
    const byId = new Map(report.accounts.map((r) => [r.userId, r]));
    expect(byId.get(f.ids.multiClub!)).toMatchObject({ reason: 'MULTI_CLUB', accountKind: null });
    expect(byId.get(f.ids.coachAndClub!)).toMatchObject({
      reason: 'COACH_CLUB',
      accountKind: null,
    });
    expect(byId.get(f.ids.coachOnly!)).toMatchObject({ reason: 'COACH', accountKind: null });
  });

  it('leaves the guarantee in place: a decided account cannot be mixed afterwards', async () => {
    await expect(
      asAppSuperuser(db, (tx) =>
        tx.tenantMembership.create({
          data: {
            userId: f.ids.owner!,
            tenantId: f.b.tenantId,
            role: 'STAFF',
            status: 'ACTIVE',
          },
        }),
      ),
    ).rejects.toThrow();
  });
});
