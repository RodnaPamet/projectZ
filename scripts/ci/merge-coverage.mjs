// Merge the coverage of several test runs and hold the total to the floor (#542).
//
//   node scripts/ci/merge-coverage.mjs <dir> [<dir>…]
//
// Each <dir> is searched for `coverage-final.json`, the file Jest's `json`
// coverage reporter writes: one per shard of the Coverage job. The maps are
// merged with istanbul's own merge (a statement run in ANY shard is covered),
// and the merged totals are compared with `jest.thresholds.json`.
//
// ═══ WHY THE FLOOR IS CHECKED HERE AND NOT BY JEST ═══
//
// A shard runs half the suites, so half the code looks untested to it: Jest's
// `--coverageThreshold` on a shard would fail every time. The floor is one
// number over the WHOLE suite, so it can only be checked once the shards are
// back together. That is this script, and it fails closed: no input, an
// unreadable map, or a missing shard is an error, never a pass.
//
// ═══ THE SAME NUMBERS AS ONE RUN, OR SLIGHTLY STRICTER ═══
//
// Measured on the unit project (2026-10-14), two halves merged against one
// whole run: branches, functions and lines were identical to the hundredth;
// statements read 25.81% against 25.96%. The reason: a file that one half
// never loads is instrumented there from its source alone, without the helper
// statements TypeScript emits when the file is really compiled and run, so its
// statement positions differ slightly and the merge keeps the union. Covered
// statements are the same; the total is a little larger. So the merged
// statements figure can only be equal or lower, which is the strict side of a
// floor. CI's margin over the floor was 9 points when this was written.
//
// Exit 0 at or above the floor; 1 below it; 2 when the inputs are not what
// they should be.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import libCoverage from 'istanbul-lib-coverage';

export const METRICS = ['statements', 'branches', 'functions', 'lines'];

/** Every `coverage-final.json` under `dir`, at any depth. */
export function findMaps(dir) {
  const out = [];
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const path = join(d, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (name === 'coverage-final.json') out.push(path);
    }
  };
  if (existsSync(dir)) walk(dir);
  return out.sort();
}

/** One map from many: a line any of them ran is a line that ran. */
export function mergeMaps(maps) {
  const merged = libCoverage.createCoverageMap({});
  for (const map of maps) merged.merge(map);
  return merged;
}

/** `{ lines: 81.2, … }` for a merged map, as percentages. */
export function totals(map) {
  const summary = map.getCoverageSummary();
  return Object.fromEntries(METRICS.map((m) => [m, summary[m].pct]));
}

/** The metrics below their floor, as `{ metric, actual, minimum }`. */
export function shortfalls(actual, minimum) {
  return METRICS.filter((m) => minimum[m] !== undefined)
    .filter((m) => !(Number(actual[m]) >= Number(minimum[m])))
    .map((m) => ({ metric: m, actual: actual[m], minimum: minimum[m] }));
}

export function main(argv, { expect = Number(process.env.COVERAGE_SHARDS ?? 0) } = {}) {
  const dirs = argv.length > 0 ? argv : ['coverage'];
  const files = dirs.flatMap(findMaps);
  if (files.length === 0) {
    console.error(`No coverage-final.json under: ${dirs.join(', ')}. Nothing was measured.`);
    return 2;
  }
  // A shard that failed to upload must not turn into "its code is untested,
  // but the rest is fine": say how many maps were expected.
  if (expect > 0 && files.length !== expect) {
    console.error(
      `Expected ${expect} coverage map(s), found ${files.length}:\n  ${files.join('\n  ')}`,
    );
    return 2;
  }

  let merged;
  try {
    merged = mergeMaps(files.map((f) => JSON.parse(readFileSync(f, 'utf8'))));
  } catch (err) {
    console.error(`A coverage map could not be read: ${err instanceof Error ? err.message : err}`);
    return 2;
  }
  if (merged.files().length === 0) {
    console.error('The merged coverage map names no file. Nothing was measured.');
    return 2;
  }

  const minimum = JSON.parse(readFileSync('jest.thresholds.json', 'utf8')).global ?? {};
  const actual = totals(merged);
  console.log(`Coverage of ${merged.files().length} files, merged from ${files.length} run(s):`);
  for (const m of METRICS) {
    const floor = minimum[m] === undefined ? '' : `  (floor ${minimum[m]}%)`;
    console.log(`  ${m.padEnd(10)} ${String(actual[m]).padStart(6)}%${floor}`);
  }

  const below = shortfalls(actual, minimum);
  if (below.length > 0) {
    for (const b of below) {
      console.error(
        `::error::${b.metric} coverage is ${b.actual}%, below the floor of ${b.minimum}%.`,
      );
    }
    return 1;
  }
  console.log('At or above the floor.');
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv.slice(2)));
}
