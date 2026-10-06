import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

import { readAccountStanding } from '@/app-layer/repositories/account';
import { decideOwnerAssignment, type OwnerAssignment } from '@/lib/auth/account-kind';

/**
 * What `create-venue-org.ts` and `onboard-club.ts` share: the owner
 * connection, and the rule for who may own a club.
 *
 * Both scripts create tenants, so both carry the same guarantees, and the
 * reasons are written down once, in `create-venue-org.ts`'s header:
 *
 *   - a script, not a route: creating a tenant cannot be authorised BY one;
 *   - the OWNER connection (`DIRECT_DATABASE_URL`), checked by name, because
 *     `playerz_app` owns no table after P24 and there is no tenant to bind RLS
 *     to before the tenant exists;
 *   - no credential: the owner row has no passwordHash, and is matched by
 *     email the first time they sign in;
 *   - one account, one kind (#263): the owner is a CLUB account of this club
 *     only, and anybody else is refused by name before anything is written.
 *
 * Moving the rule here is what keeps the two scripts from drifting: an owner
 * refused by one and accepted by the other would be a bug nobody notices
 * until a player finds themselves running a club.
 */

export const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** A `@db.Time(0)` column. Prisma wants a Date; only the clock part is stored. */
export function timeOfDay(hhmm: string): Date {
  const [h, m] = hhmm.split(':').map(Number);
  return new Date(Date.UTC(1970, 0, 1, h!, m!, 0));
}

/** The clock a `@db.Time(0)` column holds, as HH:MM. Read through UTC: see `timeOfDay`. */
export function clockOf(t: Date): string {
  return `${String(t.getUTCHours()).padStart(2, '0')}:${String(t.getUTCMinutes()).padStart(2, '0')}`;
}

export function die(message: string): never {
  console.error(`\n${message}\n`);
  process.exit(1);
}

/**
 * A client on the OWNER connection, or a refusal that names the variable.
 *
 * "permission denied for table venue_org" is what DATABASE_URL produces, and
 * it does not tell you which of the two URLs was wrong.
 */
export function ownerConnection(): PrismaClient {
  const url = process.env.DIRECT_DATABASE_URL;
  if (!url) {
    die(
      'DIRECT_DATABASE_URL is not set.\n\n' +
        'This needs the OWNER connection. The runtime role `playerz_app` owns no\n' +
        'table (P24) and there is no tenant to bind RLS to before the tenant\n' +
        'exists, so DATABASE_URL cannot do this — it would fail with "permission\n' +
        'denied for table venue_org", which does not tell you which URL was wrong.',
    );
  }
  return new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
}

/** Refuse to go on as anything but the role that owns the tables. */
export async function assertOwnerRole(prisma: PrismaClient): Promise<void> {
  const [{ current_user: role, rolsuper }] = await prisma.$queryRawUnsafe<
    { current_user: string; rolsuper: boolean }[]
  >(`SELECT current_user, (SELECT rolsuper FROM pg_roles WHERE rolname = current_user)`);

  if (!rolsuper) {
    die(
      `Connected as "${role}", which is not the owner.\n\n` +
        'DIRECT_DATABASE_URL is pointing at the runtime role. Point it at the\n' +
        'role that owns the tables.',
    );
  }
}

/** The owner's address as it is stored and matched at sign-in. */
export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

export class OwnerRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OwnerRefusedError';
  }
}

/** Why an address cannot own this club, in words the operator can act on. */
export function ownerRefusalMessage(
  email: string,
  refusal: Extract<OwnerAssignment, { ok: false }>['refusal'],
): string {
  return {
    PLAYER_ACCOUNT:
      `${email} is a PLAYER account that already plays at a club. One account is one ` +
      'kind (#263): the club needs a separate account for its owner — use another address.',
    COACH_ACCOUNT: `${email} is a COACH account. A club's owner needs a club account of its own — use another address.`,
    CLUB_ACCOUNT_TAKEN:
      `${email} is the club account of another club, and a club account belongs to one ` +
      'club. Use another address for this one.',
    UNDECIDED:
      `${email} is an account the #263 migration could not decide — it held roles at ` +
      'more than one club, or a coach role. Settle it first: npm run report:undecided-accounts',
  }[refusal];
}

/** Stands in for a club that does not exist yet: every club the account holds is "another". */
const NEW_CLUB = '(new club)';

export interface OwnerDecision {
  email: string;
  /** The existing account, or null when the address is new. */
  userId: string | null;
  /** The kind the account must become, or null to leave it as it is. */
  becomes: 'CLUB' | null;
}

/**
 * ═══ THE OWNER MUST BE A CLUB ACCOUNT WITH NO OTHER CLUB (#263) ═══
 *
 * One account, one kind, and a club account belongs to one club. An address
 * that already belongs to somebody who plays, or who runs another club, is
 * refused rather than quietly converted: making a player an owner would end
 * their player memberships, and the operator typing this command is not the
 * person who should decide that.
 *
 * A brand-new address, or an account that holds nothing yet, becomes a CLUB
 * account. READS ONLY: the caller writes, so a dry run can ask the same
 * question and get the same answer.
 *
 * `db` must see every club (the owner connection), for the reason in
 * `readAccountStanding`.
 */
export async function decideOwner(
  db: PrismaClient,
  rawEmail: string,
  tenantId: string | null,
): Promise<OwnerDecision> {
  const email = normaliseEmail(rawEmail);
  const existing = await db.user.findUnique({ where: { email }, select: { id: true } });
  const standing = existing ? await readAccountStanding(db, existing.id) : null;
  const assignment: OwnerAssignment = standing
    ? decideOwnerAssignment(standing, tenantId ?? NEW_CLUB)
    : { ok: true, becomes: 'CLUB' };

  if (!assignment.ok) throw new OwnerRefusedError(ownerRefusalMessage(email, assignment.refusal));

  return {
    email,
    userId: existing?.id ?? null,
    becomes: assignment.becomes === 'CLUB' ? 'CLUB' : null,
  };
}

/**
 * Make the decided account an ACTIVE OWNER of `tenantId`. Idempotent.
 *
 * No passwordHash, on purpose: web sign-in is Google or Facebook, so a
 * password here would be an unusable secret sitting in a real user row. The
 * row waits for its owner, who is matched by email at first sign-in.
 */
export async function assignOwner(
  db: PrismaClient,
  decision: OwnerDecision,
  tenantId: string,
  ownerName: string | null,
): Promise<{ userId: string }> {
  const owner = await db.user.upsert({
    where: { email: decision.email },
    update: decision.becomes ? { accountKind: decision.becomes } : {},
    create: { email: decision.email, name: ownerName, accountKind: 'CLUB' },
    select: { id: true },
  });

  await db.tenantMembership.upsert({
    where: { userId_tenantId: { userId: owner.id, tenantId } },
    update: { role: 'OWNER', status: 'ACTIVE' },
    create: {
      userId: owner.id,
      tenantId,
      role: 'OWNER',
      status: 'ACTIVE',
      acceptedAt: new Date(),
    },
  });

  return { userId: owner.id };
}
