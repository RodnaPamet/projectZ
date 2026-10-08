import { parseArgs } from 'node:util';

import {
  AccountNotFoundForDeletionError,
  ClubAccountDeletionRefusedError,
  deleteAccount,
  UpcomingBookingsError,
  type DeletionSummary,
} from '@/app-layer/usecases/account-deletion';
import { runAsSuperuser } from '@/lib/db/rls-middleware';

import { assertOwnerRole, die, normaliseEmail, ownerConnection } from './lib/onboarding-common';

/**
 * Delete an account the person asked the platform to delete (#370): by email,
 * by phone, in person. THE SAME CODE PATH as "Изтрий профила" on /me/profile:
 * `deleteAccount` in src/app-layer/usecases/account-deletion.ts, every rule and
 * every table in one transaction. docs/platform-admin-runbook.md, "Deleting an
 * account on request", is the procedure around it.
 *
 * ═══ WHAT IT REFUSES ═══
 *
 *   - an account with an upcoming booking: the person cancels it, or leaves
 *     it, first (owner decision 1); the script lists them
 *   - a CLUB account: retiring a club (hiding it, cancelling its upcoming
 *     bookings with notice, keeping its money) is #459, not this
 *   - an address with no account, which includes one already deleted: a
 *     tombstone does not keep the address
 *
 * ═══ USAGE ═══
 *
 *   npm run delete:account -- --email maria@example.bg --dry-run
 *   npm run delete:account -- --email maria@example.bg
 *
 * Needs DIRECT_DATABASE_URL (the owner connection), like the other operator
 * scripts. `--dry-run` runs the whole deletion and rolls it back, printing
 * what it would have changed.
 */

const { values } = parseArgs({
  options: {
    email: { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
  },
});

class DryRunRollback extends Error {}

function printSummary(summary: DeletionSummary): void {
  const width = Math.max(...Object.keys(summary).map((k) => k.length));
  for (const [what, n] of Object.entries(summary)) {
    console.log(`  ${what.padEnd(width)}  ${n}`);
  }
}

async function main(): Promise<void> {
  if (!values.email) die('Usage: npm run delete:account -- --email <address> [--dry-run]');
  const email = normaliseEmail(values.email);
  const dryRun = values['dry-run'];

  const prisma = ownerConnection();
  await assertOwnerRole(prisma);

  const account = await runAsSuperuser(
    (db) =>
      db.user.findUnique({
        where: { email },
        select: { id: true, name: true, accountKind: true, createdAt: true },
      }),
    prisma,
  );
  if (!account) {
    die(
      `No account has the address ${email}.\n\n` +
        'A deleted account no longer carries its address, so this is also what an\n' +
        'account deleted already looks like.',
    );
  }

  console.log(
    `\nAccount ${account.id} (${account.accountKind ?? 'undecided'}), created ${account.createdAt.toISOString().slice(0, 10)}`,
  );

  let summary: DeletionSummary = {};
  try {
    await runAsSuperuser(async (db) => {
      summary = await deleteAccount(db, { userId: account.id, by: 'operator' });
      if (dryRun) throw new DryRunRollback();
    }, prisma);
  } catch (e) {
    if (e instanceof DryRunRollback) {
      console.log('\nDRY RUN: the deletion would change these rows. Nothing was written.\n');
      printSummary(summary);
      console.log('');
      return;
    }
    if (e instanceof ClubAccountDeletionRefusedError) {
      die(
        'This is a CLUB account (or it holds a club role).\n\n' +
          'Retiring a club (hiding it and its venues, cancelling its upcoming bookings\n' +
          'with notice, keeping its financial records) is not built yet: #459. The\n' +
          'runbook says what to do by hand meanwhile.',
      );
    }
    if (e instanceof UpcomingBookingsError) {
      const lines = e.bookings.map(
        (b) =>
          `  ${b.startTs.toISOString()}  ${b.venueName}, ${b.courtName}  (${b.role === 'BOOKER' ? 'booked it' : 'added to it'})`,
      );
      die(
        `The account has ${e.total} upcoming booking(s). The person cancels the ones they\n` +
          'made and leaves the ones they were added to (owner decision 1, #370); one\n' +
          'too late to cancel is played first.\n\n' +
          lines.join('\n'),
      );
    }
    if (e instanceof AccountNotFoundForDeletionError) die('The account is gone already.');
    throw e;
  } finally {
    await prisma.$disconnect();
  }

  console.log('\n✓ Deleted. Every session of the account is signed out. Rows changed:\n');
  printSummary(summary);
  console.log('');
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
