import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

import { formatItems, onboardClub, parseClubSpec } from './lib/club-onboarding';
import { assertOwnerRole, die, ownerConnection } from './lib/onboarding-common';

/**
 * Onboard a pilot club from a JSON spec (#365): the club, its owner, its
 * venues, their courts with grids, durations, hours and prices.
 *
 * There is no public club sign-up in the pilot (Q11): the owner of playerz
 * onboards each club with this. Why a script and not a route, why it needs
 * `DIRECT_DATABASE_URL`, and the owner rule (#263) are explained in
 * `create-venue-org.ts`, and the code that enforces them is shared with it
 * (`lib/onboarding-common.ts`). The spec format, and how to run this on
 * staging and production, are in docs/onboarding/runbook.md.
 *
 * ═══ USAGE ═══
 *
 *   npm run onboard:club -- --spec docs/onboarding/example-club.json --dry-run
 *   npm run onboard:club -- --spec docs/onboarding/example-club.json
 *   npm run onboard:club -- --spec club.json --update --operator ivo@playerz.bg
 *
 *   --dry-run   print what would be created or changed; write nothing
 *   --update    apply differences to what already exists (audited)
 *   --operator  who is running it, recorded on the audit rows; required with --update
 *
 * Re-running the same spec is a no-op. Adding a venue or court to the spec
 * adds it; nothing is ever deleted. A value that differs from what exists is
 * reported and NOT applied without --update — a mistyped price is not fixed
 * by quietly overwriting, and a club's own edits in the app are not quietly
 * reverted by an old spec.
 *
 * Exit status: 0 applied, nothing to do, or dry run; 1 anything refused.
 */

const { values } = parseArgs({
  options: {
    spec: { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
    update: { type: 'boolean', default: false },
    operator: { type: 'string' },
  },
});

if (!values.spec) {
  die('Missing --spec path/to/club.json\n\nSee docs/onboarding/runbook.md for the format.');
}
if (values.update && !values['dry-run'] && !values.operator?.trim()) {
  die(
    '--update needs --operator <your email>.\n\n' +
      'Changing a live club is audited, and an audit row is only worth something\n' +
      'if there is a person to ask about it.',
  );
}

let raw: unknown;
try {
  raw = JSON.parse(readFileSync(values.spec, 'utf8'));
} catch (err) {
  die(`Cannot read ${values.spec} as JSON: ${err instanceof Error ? err.message : String(err)}`);
}

const parsed = parseClubSpec(raw);
if (!parsed.ok) {
  die(
    `${values.spec} is not a valid club spec. Nothing was written.\n\n` +
      parsed.errors.map((e) => `  ✖ ${e}`).join('\n'),
  );
}
const spec = parsed.spec;

const prisma = ownerConnection();

async function main(): Promise<void> {
  await assertOwnerRole(prisma);

  const result = await onboardClub(prisma, spec, {
    dryRun: values['dry-run'],
    update: values.update,
    operator: values.operator?.trim() || null,
    specPath: values.spec!,
  });

  switch (result.outcome) {
    case 'refused':
      die(`✖ ${result.reason}\n\nNothing was written.`);
    // falls through — `die` exits

    case 'needs-update':
      console.log(`\n${spec.club.slug}: this spec differs from what exists.\n`);
      console.log(formatItems(result.items));
      die(
        '✖ Nothing was written. These are values somebody set — perhaps the club, in the\n' +
          '  app. If the spec is right, re-run with --update --operator <you>; if the\n' +
          '  database is right, fix the spec.',
      );

    case 'dry-run':
      console.log(`\nDRY RUN for ${spec.club.slug}: nothing was written.\n`);
      console.log(formatItems(result.items));
      if (result.needsUpdate) {
        console.log('\n  Changes (~) above would be refused without --update.');
      }
      console.log('');
      return;

    case 'no-op':
      console.log(`\n✓ ${spec.club.slug}: everything in the spec already exists. Nothing written.`);
      printWhere(result.venues);
      return;

    case 'applied':
      console.log(`\n✓ ${spec.club.name}  (tenant ${result.tenantId})\n`);
      console.log(formatItems(result.items));
      printWhere(result.venues);
      return;
  }
}

function printWhere(
  venues: Array<{ name: string; publicSlug: string | null; lat: number; lng: number }>,
) {
  console.log(`\n  club page   /clubs/${spec.club.slug}`);
  console.log(`  admin       /t/${spec.club.slug}/admin`);
  for (const v of venues) {
    console.log(`  venue       /venues/${v.publicSlug ?? '?'}   ${v.name}`);
    // Eyeball the pin: inside Bulgaria is checked, the right street is not.
    console.log(
      `              https://www.openstreetmap.org/?mlat=${v.lat}&mlon=${v.lng}#map=17/${v.lat}/${v.lng}`,
    );
  }
  console.log('');
}

main()
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
