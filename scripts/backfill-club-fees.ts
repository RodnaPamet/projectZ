import { parseArgs } from 'node:util';

import { MISSING_CHARGES_PER_RUN, recordMissingFeeCharges } from '@/app-layer/usecases/club-fees';
import { runAsSuperuser } from '@/lib/db/rls-middleware';

import { assertOwnerRole, die, ownerConnection } from './lib/onboarding-common';

/**
 * Write the club fee CHARGE line (#372) for every COMPLETED online booking that
 * has none: the bookings completed before P48 shipped, or by the previous
 * image after a rollback.
 *
 * ═══ SAFE TO RUN AT ANY TIME, ANY NUMBER OF TIMES ═══
 *
 * It is the completion sweep's own catch-up (`recordMissingFeeCharges`) with
 * the look-back removed, in batches of 500, each in its own transaction. A
 * line is `INSERT … ON CONFLICT DO NOTHING` on (booking, kind), so a booking
 * that already has its charge, or that the sweep charges while this runs, is
 * never charged twice. Nothing is updated or deleted; the ledger refuses both.
 *
 * The rate and the free period are each club's terms AT THE TIME OF THE RUN,
 * which is what the sweep would have used had it charged the booking then.
 * Run it right after the deploy, before any club's terms are changed.
 *
 * The sweep repairs the last 7 days by itself every minute; this is for the
 * history behind that.
 *
 * ═══ USAGE ═══
 *
 *   npm run backfill:club-fees -- --dry-run
 *   npm run backfill:club-fees
 *
 * Needs DIRECT_DATABASE_URL (the owner connection), like the other operator
 * scripts. `--dry-run` counts what would be written and rolls back.
 */

const { values } = parseArgs({
  options: { 'dry-run': { type: 'boolean', default: false } },
});

class DryRunRollback extends Error {}

const prisma = ownerConnection();

async function main(): Promise<void> {
  await assertOwnerRole(prisma);
  const dryRun = values['dry-run'];
  const now = new Date();
  let written = 0;
  let found = 0;

  for (let batch = 1; ; batch++) {
    let result = { found: 0, written: 0, truncated: false };
    try {
      await runAsSuperuser(async (db) => {
        result = await recordMissingFeeCharges(db, { now, lookbackDays: null });
        if (dryRun) throw new DryRunRollback();
      }, prisma);
    } catch (e) {
      if (!(e instanceof DryRunRollback)) throw e;
    }
    found += result.found;
    written += result.written;
    console.log(`  batch ${batch}: ${result.found} found, ${result.written} written`);
    // A dry run rolls each batch back, so the same rows would be found again.
    if (dryRun || !result.truncated) break;
  }

  if (dryRun) {
    console.log(
      `\nDRY RUN: ${written} charge line(s) would be written` +
        (found === MISSING_CHARGES_PER_RUN ? ' in the first batch; more remain' : '') +
        '. Nothing was written.\n',
    );
  } else {
    console.log(`\n✓ ${written} charge line(s) written for ${found} booking(s).\n`);
  }
}

main()
  .catch((err: unknown) => {
    if (err instanceof Error) die(err.message);
    die(String(err));
  })
  .finally(() => prisma.$disconnect());
