/**
 * WHICH INFLECT PATHS PLAYERZ MUST ACCOUNT FOR.
 *
 * docs/ui-sync/inflect-paths.txt lists every inflect path under the synced
 * component directories at one inflect commit, plus the src/lib modules playerz
 * vendors. The guardrail reads it in CI, where no inflect clone exists, and
 * demands a manifest row for every playerz file at one of those paths. That is
 * what stops a file being copied from inflect by hand, outside copy.mjs: it
 * lands at an inflect path, and nothing would otherwise know it is a copy.
 *
 *   node scripts/ui-sync/paths.mjs [--ref <rev>]
 *       report playerz files at inflect paths that have no row
 *   ... --write
 *       rewrite inflect-paths.txt at that commit
 *   ... --add-pending [--base <sha>] [src/lib/extra.ts ...]
 *       give each of them a 'pending' row (baseSha: the 2026-07 port base)
 *
 * Extra positional paths add src/lib modules to the list; the lib modules that
 * already have rows are always listed. This is how the manifest was first built:
 *
 *   node scripts/ui-sync/paths.mjs --ref origin/main --write --add-pending \
 *     src/lib/cn.ts src/lib/theme-constants.ts \
 *     src/lib/hooks/use-keyboard-shortcut.tsx src/lib/hooks/keyboard-shortcut-internals.ts
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import {
  REPO_ROOT,
  UsageError,
  git,
  inflectDir,
  listFiles,
  parseCli,
  playerzTree,
  resolveRev,
  run,
} from './lib.mjs';
import {
  INFLECT_PATHS_FILE,
  PORT_BASE,
  SYNCED_DIRS,
  formatInflectPaths,
  manifestFor,
  readAllRows,
  readManifest,
  sha256,
  writeManifest,
} from './manifest.mjs';

const USAGE = `Usage: node scripts/ui-sync/paths.mjs [--ref <rev>] [--root <dir>] [--write]
                                    [--add-pending [--base <sha>]] [src/lib/path ...]`;

async function main() {
  const { flags, positionals } = parseCli(process.argv.slice(2), {
    values: ['ref', 'root', 'base'],
    switches: ['write', 'add-pending'],
  });
  const root = resolve(flags.root ?? REPO_ROOT);
  const dir = inflectDir();
  const sha = resolveRev(dir, flags.ref ?? 'origin/main', 'inflect');

  const extra = positionals.map((p) => p.replace(/^\.\//, ''));
  for (const p of extra) {
    if (!p.startsWith('src/lib/'))
      throw new UsageError(`${p}: only src/lib modules are added by name`);
    if (listFiles(dir, sha, [p])[0] !== p)
      throw new UsageError(`${p} is not in inflect at ${sha.slice(0, 9)}`);
  }
  const libRows = readManifest(root, 'lib').map((r) => r.inflectPath);
  const paths = [...new Set([...listFiles(dir, sha, SYNCED_DIRS), ...libRows, ...extra])].sort();

  const tree = playerzTree(root);
  const rowed = new Set(readAllRows(root).map((r) => r.path));
  const unrowed = paths.filter((p) => tree.exists(p) && !rowed.has(p));

  console.log(
    `inflect ${sha.slice(0, 9)}: ${paths.length} paths; playerz has ${paths.filter(tree.exists).length} ` +
      `of them, ${unrowed.length} without a manifest row`,
  );
  for (const p of unrowed) console.log(`  no row: ${p}`);

  if (flags['add-pending'] && unrowed.length) {
    const base = flags.base ?? PORT_BASE;
    resolveRev(dir, base, 'inflect');
    const byManifest = new Map();
    for (const p of unrowed) {
      const name = manifestFor(p);
      if (!name) throw new UsageError(`${p} is outside every manifest`);
      if (!byManifest.has(name)) byManifest.set(name, readManifest(root, name));
      byManifest.get(name).push({
        path: p,
        inflectPath: p,
        baseSha: base,
        sha: null,
        status: 'pending',
        sha256: sha256(readFileSync(join(root, p))),
      });
    }
    for (const [name, rows] of byManifest) writeManifest(root, name, rows);
    console.log(`added ${unrowed.length} pending rows (baseSha ${base})`);
  }

  if (flags.write) {
    const date = git(dir, ['show', '-s', '--format=%cs', sha]).stdout.trim();
    writeFileSync(join(root, INFLECT_PATHS_FILE), formatInflectPaths({ sha, date, paths }));
    console.log(`wrote ${INFLECT_PATHS_FILE}`);
  }
}

run(main, USAGE);
