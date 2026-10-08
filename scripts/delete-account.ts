import { parseArgs } from 'node:util';

import {
  AccountNotFoundForDeletionError,
  ClubAccountDeletionRefusedError,
  deleteAccount,
  deletionStanding,
  UpcomingBookingsError,
  type ClubCredit,
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
 * ═══ A DRY RUN UNLESS TOLD OTHERWISE ═══
 *
 * Without `--confirm` it runs the whole deletion, rolls it back and prints the
 * account it found (its id, kind and name) and every row it would change. To
 * delete, run it again with `--confirm <that id>`: the address must still lead
 * to the account the dry run showed, or nothing happens. A mistyped address
 * that belongs to somebody else is caught there, and an `npm run` that eats a
 * flag cannot turn a look into a deletion.
 *
 * ═══ WHAT IT REFUSES ═══
 *
 *   - an account with an upcoming booking: the person cancels it, or leaves
 *     it, first (owner decision 1); the script lists them
 *   - a club account: one whose kind is CLUB, or any account holding an OWNER,
 *     MANAGER or STAFF role at a club. Retiring a club (hiding it, cancelling
 *     its upcoming bookings with notice, keeping its money) is #459, not this
 *   - an address with no account, which includes one already deleted: a
 *     tombstone does not keep the address
 *
 * ═══ USAGE ═══
 *
 *   npm run delete:account -- --email maria@example.bg
 *   npm run delete:account -- --email maria@example.bg --confirm <account id>
 *
 * Needs DIRECT_DATABASE_URL (the owner connection), like the other operator
 * scripts.
 */

const USAGE =
  'Usage: npm run delete:account -- --email <address> [--confirm <account id>]\n\n' +
  'Without --confirm it is a dry run: it shows the account and what would change.';

const { values } = parseArgs({
  options: {
    email: { type: 'string' },
    confirm: { type: 'string' },
    // The old spelling of the default. Accepted so a habit cannot fail, and
    // refused next to --confirm, where the two would contradict each other.
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

/** The credit the account loses (owner decision: warn, then allow), for the operator to pass on. */
function printCredit(credit: ClubCredit[], lost: 'would lose' | 'lost'): void {
  if (credit.length === 0) return;
  console.log(`\nUnused credit the account ${lost}:\n`);
  for (const c of credit) console.log(`  ${c.club}  ${(c.balanceCents / 100).toFixed(2)} EUR`);
}

async function main(): Promise<void> {
  if (!values.email) die(USAGE);
  if (values.confirm !== undefined && values['dry-run']) {
    die('--dry-run and --confirm contradict each other: pass one.\n\n' + USAGE);
  }
  const email = normaliseEmail(values.email);
  const confirmed = values.confirm?.trim();
  if (values.confirm !== undefined && !confirmed)
    die('--confirm needs the account id.\n\n' + USAGE);

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

  // The address leads somewhere else than the dry run showed: a typo, or the
  // wrong request. Its id is not printed, so the way on is a fresh dry run.
  if (confirmed && confirmed !== account.id) {
    die(
      `The address ${email} belongs to a different account than ${confirmed}.\n\n` +
        'Nothing was deleted. Run the dry run for this address again, check the account\n' +
        'it shows, and confirm that id.',
    );
  }

  console.log(
    `\nAccount ${account.id} (${account.accountKind ?? 'undecided'}), ` +
      `${account.name ?? 'no name'}, created ${account.createdAt.toISOString().slice(0, 10)}`,
  );

  const dryRun = !confirmed;
  let summary: DeletionSummary = {};
  let credit: ClubCredit[] = [];
  try {
    await runAsSuperuser(async (db) => {
      const standing = await deletionStanding(db, account.id);
      if (standing.kind !== 'club') credit = standing.credit;
      summary = await deleteAccount(db, { userId: account.id, by: 'operator' });
      if (dryRun) throw new DryRunRollback();
    }, prisma);
  } catch (e) {
    if (e instanceof DryRunRollback) {
      console.log('\nDRY RUN: the deletion would change these rows. Nothing was written.\n');
      printSummary(summary);
      printCredit(credit, 'would lose');
      console.log(
        `\nTo delete this account, run it again with --confirm ${account.id}:\n\n` +
          `  npm run delete:account -- --email ${email} --confirm ${account.id}\n`,
      );
      return;
    }
    if (e instanceof ClubAccountDeletionRefusedError) {
      die(
        'This is a CLUB account (or it holds a club role).\n\n' +
          'Retiring a club (hiding it and its venues, cancelling its upcoming bookings\n' +
          'with notice, keeping its financial records) is not built yet: #459. The\n' +
          'runbook says what to do meanwhile.',
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
  printCredit(credit, 'lost');
  console.log('');
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
