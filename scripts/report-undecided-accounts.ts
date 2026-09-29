import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

/**
 * The accounts #263's migration would not decide, and why. READ-ONLY.
 *
 * ═══ WHAT THEY ARE ═══
 *
 * "One account, one kind": PLAYER, CLUB (one club) or COACH. The p37 migration
 * turned every account holding exactly one club role into a CLUB account and
 * ended its player memberships — "the club side wins". Two shapes it was told
 * NOT to decide, and left exactly as they were, with `accountKind` NULL:
 *
 *   MULTI_CLUB    club roles (OWNER / MANAGER / STAFF) at two or more clubs —
 *                 a club account belongs to one club, and which one is a
 *                 question for a person
 *   COACH_CLUB    a COACH role beside a club role
 *   COACH         a COACH role alone — that would be a COACH account, which
 *                 only the coach flow may create, and it does not exist yet
 *
 * Until somebody settles them, everything that GRANTS something refuses them
 * (booking, accepting an invite, becoming an owner), and they land where #227
 * used to land them. Nothing takes their access away.
 *
 * ═══ SETTLING ONE ═══
 *
 * By hand, with the owner connection, deliberately — each is a decision about
 * a real person's clubs. Suspend or expire the memberships that should not
 * stay, then set the kind; the database refuses a kind the remaining ACTIVE
 * memberships do not fit (`account_kind_membership_trg`), so a mistake is an
 * error, not a mixed account.
 *
 * ═══ WHY A SCRIPT ═══
 *
 * The same reasoning as `grant-platform-admin`: this reads every club's
 * memberships, and a route that could do that is a larger blast radius than
 * the question is worth. It opens a READ ONLY transaction, so it cannot write
 * whatever it is pointed at.
 *
 * ═══ USAGE ═══
 *
 *   npm run report:undecided-accounts
 *   npm run report:undecided-accounts -- --json
 */

const url = process.env.DIRECT_DATABASE_URL ?? process.env.DATABASE_URL;
if (!url) {
  console.error('\nNeither DIRECT_DATABASE_URL nor DATABASE_URL is set.\n');
  process.exit(1);
}

const asJson = process.argv.includes('--json');

type Reason = 'MULTI_CLUB' | 'COACH_CLUB' | 'COACH';

interface Row {
  userId: string;
  email: string;
  accountKind: string | null;
  clubs: number;
  coach: boolean;
  memberships: string;
}

function reasonFor(r: Row): Reason {
  if (r.coach && r.clubs > 0) return 'COACH_CLUB';
  if (r.coach) return 'COACH';
  return 'MULTI_CLUB';
}

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });

async function main(): Promise<void> {
  const rows = await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
    // Across every club: tenant_membership is FORCE row security, and this is
    // the one question that is about all of them at once.
    await tx.$executeRawUnsafe('SET LOCAL ROLE app_superuser');

    // Derived from MEMBERSHIPS, not from `accountKind IS NULL`, so it answers
    // the same before the migration has run (what WOULD be undecided) and
    // after it (what IS). The kind is shown beside it: after the migration,
    // every row here should say NULL.
    return tx.$queryRawUnsafe<Row[]>(`
      SELECT u.id                                                         AS "userId",
             u.email                                                      AS "email",
             to_jsonb(u) ->> 'accountKind'                                AS "accountKind",
             (count(DISTINCT m."tenantId")
                FILTER (WHERE m.role IN ('OWNER', 'MANAGER', 'STAFF')))::int AS "clubs",
             bool_or(m.role = 'COACH')                                    AS "coach",
             string_agg(v.slug || ':' || m.role::text, ', ' ORDER BY v.slug) AS "memberships"
      FROM "tenant_membership" m
      JOIN "app_user" u ON u.id = m."userId"
      JOIN "venue_org" v ON v.id = m."tenantId"
      WHERE m.status = 'ACTIVE'
      GROUP BY u.id, u.email
      HAVING count(DISTINCT m."tenantId") FILTER (WHERE m.role IN ('OWNER', 'MANAGER', 'STAFF')) >= 2
          OR bool_or(m.role = 'COACH')
      ORDER BY u.email
    `);
  });

  const report = rows.map((r) => ({ ...r, reason: reasonFor(r) }));

  if (asJson) {
    console.log(JSON.stringify({ undecided: report.length, accounts: report }, null, 2));
    return;
  }

  const by = (reason: Reason) => report.filter((r) => r.reason === reason).length;
  console.log(`\nUndecided accounts (#263): ${report.length}`);
  console.log(`  club roles at two or more clubs   ${by('MULTI_CLUB')}`);
  console.log(`  a coach role beside a club role   ${by('COACH_CLUB')}`);
  console.log(`  a coach role alone                ${by('COACH')}\n`);

  for (const r of report) {
    console.log(`  ${r.reason.padEnd(10)} ${r.email}  kind=${r.accountKind ?? 'NULL'}`);
    console.log(`             ${r.memberships}`);
  }
  if (report.length > 0) console.log('');
}

main()
  .catch((err: unknown) => {
    // Not just `.message`: a refused connection arrives as an AggregateError
    // whose message is empty, which printed nothing at all and exited 1.
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
