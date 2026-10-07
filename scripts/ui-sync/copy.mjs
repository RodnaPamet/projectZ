/**
 * THE ONLY WAY A VENDORED FILE CHANGES: COPY IT FROM INFLECT.
 *
 *   node scripts/ui-sync/copy.mjs --ref <sha|origin/main> <inflect path|dir> ...
 *
 * Each file is read from inflect at --ref, run through this repo's prettier
 * (lib.mjs normalise), and written at the same path here. Its manifest row
 * becomes { baseSha: sha, sha, status: 'vendored', sha256 of the bytes written };
 * a new file gets a new row in the manifest its directory maps to. The inflect
 * commit becomes the row's merge base, so status.mjs attributes later drift
 * against it rather than against the 2026-07 port.
 *
 * A directory copies every code file beneath it (ts, tsx, js, mjs, css, json)
 * and never inflect's docs: its GUIDE.md files describe compliance pages.
 *
 * A path names the file in either of inflect's layouts (inflect-package.mjs):
 * src/<p>, or packages/ui/src/<p> once inflect #3046 has moved it into the
 * @inflect/ui package. Both are copied to src/<p> here, and the row records
 * where inflect had it at --ref. A directory is read in both layouts, because
 * inflect moves a directory's files into the package over several PRs.
 *
 * It then lists the imports playerz still cannot resolve, because a copied
 * file that imports a module playerz lacks fails the typecheck, not the copy.
 *
 * Fetch inflect first (`git -C <inflect> fetch origin`); --ref is required so
 * the commit a copy came from is always a decision, never a default.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { PACKAGE_SRC, inflectLocations, playerzPath } from './inflect-package.mjs';
import {
  REPO_ROOT,
  UsageError,
  inflectDir,
  listFiles,
  normalise,
  parseCli,
  playerzTree,
  readBlobs,
  resolveRev,
  run,
  unresolvedImports,
} from './lib.mjs';
import { MANIFEST_NAMES, manifestFor, readManifest, sha256, writeManifest } from './manifest.mjs';

/** The file's text, or null when there is none yet. */
function readIfExists(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    throw err;
  }
}

const USAGE = `Usage: node scripts/ui-sync/copy.mjs --ref <inflect-rev> [--root <dir>] <inflect path|dir> ...

  --ref <rev>   inflect commit to copy from (a SHA, or origin/main after a fetch)
  --root <dir>  playerz checkout to write into (default: this one)`;

const COPYABLE = /\.(?:tsx?|jsx?|mjs|cjs|css|json)$/;

async function main() {
  const { flags, positionals } = parseCli(process.argv.slice(2), { values: ['ref', 'root'] });
  if (!flags.ref) throw new UsageError('--ref is required.');
  if (positionals.length === 0) throw new UsageError('Name at least one inflect path.');
  const root = resolve(flags.root ?? REPO_ROOT);
  const dir = inflectDir();
  const sha = resolveRev(dir, flags.ref, 'inflect');
  const short = sha.slice(0, 9);

  const files = [];
  for (const arg of positionals) {
    const p = arg.replace(/^\.\//, '').replace(/\/+$/, '');
    const locations = inflectLocations(p);
    const listed = listFiles(dir, sha, locations);
    if (listed.length === 0) {
      const others = locations.filter((at) => at !== p);
      throw new UsageError(
        `${p} does not exist in inflect at ${short}${others.length ? `, nor does ${others.join(', ')}` : ''}.`,
      );
    }
    // The path names a file (in one layout or both): that file, whatever its
    // extension. Otherwise it is a directory: the code files under it.
    const named = locations.filter((at) => listed.includes(at));
    files.push(...(named.length ? named.slice(0, 1) : listed.filter((f) => COPYABLE.test(f))));
  }

  // One inflect file per playerz path. Both layouts at once is a file inflect
  // keeps twice; the package's is the one that moved, so it wins.
  const byTarget = new Map();
  for (const f of files) {
    const target = playerzPath(f);
    const held = byTarget.get(target);
    if (held && held !== f) {
      console.log(`inflect has both ${held} and ${f} at ${short}; copying the package's.`);
    }
    if (!held || f.startsWith(PACKAGE_SRC)) byTarget.set(target, f);
  }

  const manifests = new Map(MANIFEST_NAMES.map((name) => [name, readManifest(root, name)]));
  // Keyed by the src/ form of inflectPath, so a row still finds its file after
  // inflect moves it into the package, and before its inflectPath is re-pointed.
  const byInflectPath = new Map();
  for (const [name, rows] of manifests)
    for (const row of rows) byInflectPath.set(playerzPath(row.inflectPath), { name, row });

  // Every target is checked before anything is written: a refusal halfway
  // through would leave files copied under rows that still describe the old ones.
  const plan = [...byTarget.values()].map((inflectPath) => {
    const existing = byInflectPath.get(playerzPath(inflectPath));
    const path = existing?.row.path ?? playerzPath(inflectPath);
    const name = manifestFor(path);
    if (!name) {
      throw new UsageError(
        `${path} is outside every manifest. Only the UI under src/components/{ui,layout,theme,` +
          `nav,filters} and the src/lib modules it needs are vendored.`,
      );
    }
    return { inflectPath, path, name, existing };
  });

  const blobs = readBlobs(
    dir,
    plan.map((p) => `${sha}:${p.inflectPath}`),
  );
  const touched = new Set();
  const report = [];
  for (const { inflectPath, path, name, existing } of plan) {
    const text = await normalise(blobs.get(`${sha}:${inflectPath}`), path);
    const target = join(root, path);
    // One read that tolerates ENOENT, not existsSync-then-read: the check and
    // the read can see different files (CodeQL js/file-system-race).
    const before = readIfExists(target);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, text);

    const row = {
      path,
      inflectPath,
      baseSha: sha,
      sha,
      status: 'vendored',
      sha256: sha256(Buffer.from(text)),
    };
    const rows = manifests.get(name).filter((r) => r.path !== path);
    manifests.set(name, [...rows, row]);
    touched.add(name);

    const verb = before === null ? 'new      ' : before === text ? 'unchanged' : 'changed  ';
    const was = [
      existing?.row.status === 'local-diff' ? `replaces a local-diff: ${existing.row.reason}` : '',
      existing && existing.row.inflectPath !== inflectPath
        ? `inflect has it at ${inflectPath}`
        : '',
    ]
      .filter(Boolean)
      .map((w) => `  (${w})`)
      .join('');
    report.push(`  ${verb} ${path}${was}`);
  }
  for (const name of touched) writeManifest(root, name, manifests.get(name));

  console.log(`Copied ${report.length} file(s) from inflect ${short} (${sha}):`);
  console.log(report.join('\n'));

  const tree = playerzTree(root);
  const gaps = plan
    .map(({ path }) => [
      path,
      unresolvedImports(readFileSync(join(root, path), 'utf8'), path, tree),
    ])
    .filter(([, missing]) => missing.length);
  if (gaps.length) {
    console.log('\nImports playerz cannot resolve yet (copy them too, or add the package):');
    for (const [path, missing] of gaps) console.log(`  ${path}: ${missing.join(', ')}`);
  }
  console.log(
    '\nNext: npx jest tests/guardrails/ui-sync-manifest.test.ts\n' +
      `      node scripts/ui-sync/status.mjs --ref ${short} ${plan.length === 1 ? plan[0].path : ''}`.trimEnd(),
  );
}

run(main, USAGE);
