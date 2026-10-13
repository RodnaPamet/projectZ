import { parseArgs } from 'node:util';

import {
  AccountNotFoundForDeletionError,
  deleteAccount,
  purgeAccountMedia,
  UpcomingBookingsError,
  type DeletionSummary,
} from '@/app-layer/usecases/account-deletion';
import { cancelUpcomingBookings, setClubStatus } from '@/app-layer/usecases/club-status';
import { runAsSuperuser } from '@/lib/db/rls-middleware';

import { assertOwnerRole, die, normaliseEmail, ownerConnection } from './lib/onboarding-common';

/**
 * Retire a club whose account asked to be deleted (#459; owner decision 3 on
 * #370: a CLUB account can't delete itself, it asks, and the platform does
 * it). docs/platform-admin-runbook.md, "Deleting a club account on request".
 *
 * In this order, each step the platform's own code:
 *
 *   1. close the club (`setClubStatus` → CLOSED, audited as the operator):
 *      hidden from players and unbookable from that moment, for good
 *   2. cancel its upcoming bookings as the club, each player told
 *      (`cancelUpcomingBookings`), and cut its weekly series at today
 *   3. delete the holder's account (`deleteAccount`, by the operator), now
 *      that the club it ran is closed; its personal data goes as any
 *      account's does, and its picture's copy with it
 *
 * Kept, because they are the club's money and history, not the holder's:
 * bookings, fee lines, payments, the credit ledger, the audit log and the
 * statements. Other staff at the club are other people with their own
 * accounts; their roles there stop meaning anything once it is closed.
 *
 * ═══ A DRY RUN UNLESS TOLD OTHERWISE ═══
 *
 * Without `--confirm` it prints the account, its club, how many upcoming
 * bookings would be cancelled and who else works there, and writes nothing.
 * To retire, run it again with `--confirm <club id>`: the address must still
 * lead to that club, or nothing happens.
 *
 *   npm run retire:club -- --email owner@club.bg
 *   npm run retire:club -- --email owner@club.bg --confirm <club id> --reason "asked by email 2026-10-20"
 *
 * Needs DIRECT_DATABASE_URL (the owner connection), like the other operator
 * scripts, and DATABASE_URL for the bookings' tenant-bound cancellations.
 */

const USAGE =
  'Usage: npm run retire:club -- --email <owner address> [--confirm <club id> --reason "<why>"]\n\n' +
  'Without --confirm it is a dry run: it shows the club and what would change.';

const { values } = parseArgs({
  options: {
    email: { type: 'string' },
    confirm: { type: 'string' },
    reason: { type: 'string' },
  },
});

async function main(): Promise<void> {
  if (!values.email) die(USAGE);
  const email = normaliseEmail(values.email);
  const confirmed = values.confirm?.trim();
  if (values.confirm !== undefined && !confirmed) die('--confirm needs the club id.\n\n' + USAGE);
  const reason = values.reason?.trim() ?? '';
  if (confirmed && reason.length < 12) {
    die('--reason is required with --confirm: why, in at least 12 characters (it is audited).');
  }

  const prisma = ownerConnection();
  await assertOwnerRole(prisma);

  try {
    const found = await runAsSuperuser(async (db) => {
      const account = await db.user.findUnique({
        where: { email },
        select: { id: true, name: true, accountKind: true },
      });
      if (!account) return null;
      const roles = await db.tenantMembership.findMany({
        where: {
          userId: account.id,
          status: 'ACTIVE',
          role: { in: ['OWNER', 'MANAGER', 'STAFF'] },
        },
        select: {
          role: true,
          tenant: { select: { id: true, name: true, slug: true, status: true } },
        },
        take: 10,
      });
      return { account, roles };
    }, prisma);

    if (!found) die(`No account has the address ${email}.`);
    const { account, roles } = found;
    const owned = roles.filter((r) => r.role === 'OWNER' && r.tenant.status !== 'CLOSED');
    if (owned.length !== 1) {
      die(
        `The account ${account.id} owns ${owned.length} open club(s); this retires exactly one.\n` +
          roles.map((r) => `  ${r.role} at ${r.tenant.name} (${r.tenant.status})`).join('\n'),
      );
    }
    const club = owned[0]!.tenant;

    const facts = await runAsSuperuser(async (db) => {
      const [upcoming, venues, staff] = await Promise.all([
        db.booking.count({
          where: {
            tenantId: club.id,
            status: { in: ['PENDING', 'CONFIRMED'] },
            startTs: { gt: new Date() },
          },
        }),
        db.venue.count({ where: { tenantId: club.id } }),
        db.tenantMembership.count({
          where: {
            tenantId: club.id,
            status: 'ACTIVE',
            role: { in: ['OWNER', 'MANAGER', 'STAFF'] },
            NOT: { userId: account.id },
          },
        }),
      ]);
      return { upcoming, venues, staff };
    }, prisma);

    console.log(
      `\nAccount ${account.id} (${account.accountKind ?? 'undecided'}), ${account.name ?? 'no name'}` +
        `\nClub ${club.id}: ${club.name} (/clubs/${club.slug}), ${club.status}` +
        `\n  venues: ${facts.venues}` +
        `\n  upcoming bookings to cancel, each player told: ${facts.upcoming}` +
        `\n  other staff, who keep their own accounts: ${facts.staff}`,
    );

    if (!confirmed) {
      console.log(
        '\nDRY RUN: nothing was written. To retire the club and delete the account:\n\n' +
          `  npm run retire:club -- --email ${email} --confirm ${club.id} --reason "<why>"\n`,
      );
      return;
    }
    if (confirmed !== club.id) {
      die(
        `The address ${email} leads to club ${club.id}, not ${confirmed}. Nothing was written.\n` +
          'Run the dry run again and confirm the club it shows.',
      );
    }

    // 1. Closed, so nothing new can be booked behind the cancellations.
    await runAsSuperuser(
      (db) => setClubStatus(db, { tenantId: club.id, to: 'CLOSED', reason, actorUserId: null }),
      prisma,
    );
    console.log(`\n✓ ${club.name} is closed.`);

    // 2. Its future, cancelled with notice.
    const bookings = await cancelUpcomingBookings({ tenantId: club.id, reason });
    console.log(
      `✓ Bookings cancelled: ${bookings.cancelled}` +
        (bookings.failed ? `, FAILED: ${bookings.failed} (see the club-status log lines)` : '') +
        (bookings.remaining
          ? `, NOT REACHED: ${bookings.remaining} (run cancelUpcomingBookings again)`
          : ''),
    );

    // 3. The holder's account, now that its club is closed.
    let summary: DeletionSummary = {};
    try {
      summary = await runAsSuperuser(
        (db) => deleteAccount(db, { userId: account.id, by: 'operator' }),
        prisma,
      );
    } catch (e) {
      if (e instanceof UpcomingBookingsError) {
        die(
          `The club is closed, but the account still has ${e.total} upcoming booking(s) of its\n` +
            'own as a player. Cancel or leave them, then run npm run delete:account for it.',
        );
      }
      if (e instanceof AccountNotFoundForDeletionError) die('The account is gone already.');
      throw e;
    }
    const pictures = await purgeAccountMedia(account.id);
    if (pictures > 0) summary['media.avatars'] = pictures;

    console.log('✓ The account is deleted. Rows changed:\n');
    const width = Math.max(...Object.keys(summary).map((k) => k.length));
    for (const [what, n] of Object.entries(summary)) console.log(`  ${what.padEnd(width)}  ${n}`);
    console.log('');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
