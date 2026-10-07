/**
 * THREE-WAY DRIFT: FOR EVERY MANIFEST ROW, WHO CHANGED THE FILE?
 *
 *   base    inflect at the row's baseSha: the commit playerz last synced from
 *   theirs  inflect at --ref (default origin/main)
 *   ours    playerz: the working tree, or --playerz <rev>
 *
 * All three are compared after lib.mjs's normalisation, so formatting is never
 * drift. Each row gets one verdict:
 *
 *   IDENTICAL  ours equals theirs. Nothing to do.
 *   TAKE       only inflect changed. `copy.mjs --ref <sha> <path>` brings it over.
 *   KEEP       only playerz changed. Send the change upstream, then copy it back.
 *   MERGE      both changed. Upstream playerz's part first; then it is a TAKE.
 *   GONE       inflect no longer has the file, at either of its locations.
 *
 * Each side is read wherever inflect kept the file at that commit, src/<p> or
 * packages/ui/src/<p> (inflect-package.mjs): inflect #3046 moves the shared UI
 * into the @inflect/ui package one directory at a time, and a move alone is
 * not drift. A row whose file moved since its inflectPath was written is
 * listed as moved, so `paths.mjs --repoint` can catch the manifest up.
 *
 * `--port <playerz-rev>` (58a6ebd, the commit that made the 2026-07 port) also
 * marks the KEEP and MERGE rows whose whole playerz-side difference was made AT
 * the port rather than since. That is the split the re-sync plan measured on
 * 44048af vs inflect 8d2feb4e3 (430 identical; 21 inflect, 16 playerz, 10 both,
 * 3 port-time), and `--playerz 44048af --port 58a6ebd --ref 8d2feb4e3`
 * reproduces it.
 *
 * For TAKE and MERGE rows it also lists the imports in inflect's version that
 * playerz cannot resolve: the files or packages a copy would have to bring too.
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { PACKAGE_SRC } from './inflect-package.mjs';
import {
  REPO_ROOT,
  UsageError,
  comparable,
  diffCounts,
  inflectDir,
  parseCli,
  playerzTree,
  readBlobs,
  readInflectFiles,
  resolveRev,
  run,
  unresolvedImports,
} from './lib.mjs';
import { readAllRows } from './manifest.mjs';

const USAGE = `Usage: node scripts/ui-sync/status.mjs [options] [path-prefix...]

  --ref <rev>        inflect revision to compare against (default: origin/main)
  --playerz <rev>    read playerz from this commit instead of the working tree
  --port <rev>       playerz commit of the original port (58a6ebd): mark port-time edits
  --root <dir>       playerz checkout (default: this one)
  --json <file>      also write the full result as JSON ('-' for stdout)
  --markdown <file>  also write the drift-issue body as Markdown ('-' for stdout)

Reads inflect from $INFLECT_DIR, else ../inflect-compliance beside the main checkout.
path-prefix limits the report to rows whose path starts with it.`;

const ORDER = ['IDENTICAL', 'TAKE', 'KEEP', 'MERGE', 'GONE', 'MISSING'];

const MEANING = {
  IDENTICAL: 'nothing to do',
  TAKE: 'inflect changed, playerz did not: `node scripts/ui-sync/copy.mjs --ref <sha> <path>`',
  KEEP: 'playerz changed, inflect did not: send the change upstream, then copy it back',
  MERGE: "both changed: upstream playerz's part first, then copy",
  GONE:
    'inflect no longer has the file, in src/ or packages/ui/src/: move the row to available.json, ' +
    'or re-point inflectPath',
  MISSING: 'the manifest names a file playerz does not have',
};

function classify({ base, theirs, ours }) {
  if (ours == null) return 'MISSING';
  if (theirs == null) return 'GONE';
  if (ours === theirs) return 'IDENTICAL';
  if (base == null) return 'MERGE'; // no common ancestor to attribute against
  if (ours === base) return 'TAKE';
  if (theirs === base) return 'KEEP';
  return 'MERGE';
}

async function main() {
  const { flags, positionals } = parseCli(process.argv.slice(2), {
    values: ['ref', 'playerz', 'port', 'root', 'json', 'markdown'],
  });
  const root = resolve(flags.root ?? REPO_ROOT);
  const prefixes = positionals.map((p) => p.replace(/^\.\//, ''));
  const rows = readAllRows(root)
    .filter((r) => prefixes.length === 0 || prefixes.some((p) => r.path.startsWith(p)))
    .sort((a, b) => (a.path < b.path ? -1 : 1));
  if (rows.length === 0) throw new UsageError('No manifest rows match.');

  const dir = inflectDir();
  const ref = flags.ref ?? 'origin/main';
  const sha = resolveRev(dir, ref, 'inflect');
  const bases = new Map();
  for (const r of rows)
    if (!bases.has(r.baseSha)) bases.set(r.baseSha, resolveRev(dir, r.baseSha, 'inflect'));

  const inflect = readInflectFiles(
    dir,
    rows.flatMap((r) => [
      [bases.get(r.baseSha), r.inflectPath],
      [sha, r.inflectPath],
    ]),
  );
  const tree = playerzTree(root, flags.playerz ?? null);
  const ours = tree.readMany(rows.map((r) => r.path));
  const portSha = flags.port ? resolveRev(root, flags.port, 'playerz') : null;
  const port = portSha
    ? readBlobs(
        root,
        rows.map((r) => `${portSha}:${r.path}`),
      )
    : null;

  const results = [];
  for (const row of rows) {
    const theirsAt = inflect.get(`${sha}:${row.inflectPath}`);
    const theirsRaw = theirsAt?.text ?? null;
    const side = {
      base: await comparable(
        inflect.get(`${bases.get(row.baseSha)}:${row.inflectPath}`)?.text ?? null,
        row.path,
      ),
      theirs: await comparable(theirsRaw, row.path),
      ours: await comparable(ours.get(row.path), row.path),
    };
    const status = classify(side);
    const result = {
      path: row.path,
      inflectPath: row.inflectPath,
      manifest: row.manifest,
      rowStatus: row.status,
      baseSha: row.baseSha,
      status,
    };
    // Where inflect keeps it at --ref, when that is not where the row says.
    if (theirsAt && theirsAt.path !== row.inflectPath) result.movedTo = theirsAt.path;
    // Both layouts at once would be two files that playerz holds as one.
    if (theirsAt && theirsAt.found.length > 1) result.alsoAt = theirsAt.found.slice(1);
    if (status !== 'IDENTICAL' && status !== 'MISSING') {
      Object.assign(result, diffCounts(side.ours, side.theirs));
    }
    if (port && (status === 'KEEP' || status === 'MERGE')) {
      result.portTime =
        (await comparable(port.get(`${portSha}:${row.path}`), row.path)) === side.ours;
    }
    if (status === 'TAKE' || status === 'MERGE') {
      const missing = unresolvedImports(theirsRaw, row.path, tree);
      if (missing.length) result.unresolved = missing;
    }
    const notes = [];
    if (status === 'IDENTICAL' && row.status === 'local-diff') {
      notes.push('local-diff row now matches upstream: re-copy it to mark it vendored');
    }
    if (result.alsoAt) {
      notes.push(
        `inflect has both ${theirsAt.path} and ${result.alsoAt.join(', ')}; ` +
          'compared with the first, but playerz can hold only one',
      );
    }
    if (notes.length) result.note = notes.join('; ');
    results.push(result);
  }

  const counts = Object.fromEntries(
    ORDER.map((s) => [s, results.filter((r) => r.status === s).length]),
  );
  const report = {
    inflect: { dir, ref, sha, short: sha.slice(0, 9) },
    playerz: { root, rev: tree.rev },
    port: portSha,
    counts,
    portTime: port ? results.filter((r) => r.portTime).length : null,
    moved: results.filter((r) => r.movedTo).length,
    rows: results,
  };

  console.log(textReport(report));
  if (flags.json) emit(flags.json, `${JSON.stringify(report, null, 2)}\n`);
  if (flags.markdown) emit(flags.markdown, markdownReport(report));
}

function emit(target, text) {
  if (target === '-') process.stdout.write(text);
  else writeFileSync(target, text);
}

/** What a copy of inflect's version would do to the playerz file, in lines. */
const lines = (r) => (r.added === undefined ? '' : `+${r.added} -${r.removed}`);

/** The command that re-points the rows of files inflect has moved. */
const repoint = (short) => `node scripts/ui-sync/paths.mjs --ref ${short} --repoint`;

function textReport({ inflect, playerz, port, counts, portTime, moved, rows }) {
  const named = inflect.sha.startsWith(inflect.ref) ? '' : ` (${inflect.ref})`;
  const out = [
    `ui-sync status: ${rows.length} rows vs inflect ${inflect.short}${named}, ` +
      `playerz ${playerz.rev ? playerz.rev.slice(0, 9) : 'working tree'}`,
    `  ${ORDER.filter((s) => counts[s] || s !== 'MISSING')
      .map((s) => `${s} ${counts[s]}`)
      .join(' · ')}`,
  ];
  // Into the package is the way inflect moves files. The other way, the row
  // was re-pointed at a commit newer than --ref (or inflect moved it back).
  const into = rows.filter((r) => r.movedTo?.startsWith(PACKAGE_SRC)).length;
  if (into) {
    out.push(
      `  moved into ${PACKAGE_SRC} since their row was written: ${into} (compared there; ` +
        `${repoint(inflect.short)} re-points the rows)`,
    );
  }
  if (moved > into) {
    out.push(
      `  still at their src/ path in this inflect commit: ${moved - into} (compared there; ` +
        'the commit predates their move into the package)',
    );
  }
  if (port) {
    const keepPort = rows.filter((r) => r.status === 'KEEP' && r.portTime).length;
    out.push(
      `  port-time (${port.slice(0, 9)}): ${portTime} rows differ from inflect only by edits made ` +
        `at the port; KEEP since the port ${counts.KEEP - keepPort}, KEEP port-time ${keepPort}`,
    );
  }
  const width = Math.max(0, ...rows.map((r) => r.path.length));
  const shown = rows.filter((r) => r.status !== 'IDENTICAL' || r.note);
  if (shown.length) out.push('');
  for (const status of ORDER) {
    for (const r of shown.filter((x) => x.status === status)) {
      const flagsText = [r.portTime ? 'port-time' : '', r.note ?? ''].filter(Boolean).join('  ');
      out.push(
        `${status.padEnd(9)} ${r.path.padEnd(width)}  ${lines(r).padEnd(11)} ${flagsText}`.trimEnd(),
      );
    }
  }
  const gaps = rows.filter((r) => r.unresolved);
  if (gaps.length) {
    out.push('', "Imports in inflect's version that playerz cannot resolve yet:");
    for (const r of gaps) out.push(`  ${r.path}: ${r.unresolved.join(', ')}`);
  }
  return out.join('\n');
}

function markdownReport({ inflect, counts, rows }) {
  const commit = `https://github.com/RodnaPamet/inflect-compliance/commit/${inflect.sha}`;
  const out = [
    `Drift between the vendored UI (\`docs/ui-sync/manifest\`, ${rows.length} rows) and ` +
      `[inflect \`${inflect.short}\`](${commit}), with both sides normalised by this repo's prettier.`,
    '',
    '| Status | Rows | What to do |',
    '| --- | ---: | --- |',
    ...ORDER.filter((s) => counts[s] || s !== 'MISSING').map(
      (s) => `| ${s} | ${counts[s]} | ${MEANING[s].replace('<sha>', inflect.short)} |`,
    ),
  ];
  for (const status of ['TAKE', 'MERGE', 'GONE', 'MISSING', 'KEEP']) {
    const group = rows.filter((r) => r.status === status);
    if (group.length === 0) continue;
    const open = status === 'KEEP' ? '<details><summary>KEEP rows</summary>\n\n' : '';
    out.push(
      '',
      `### ${status} (${group.length})`,
      '',
      `${open}| Path | A copy would add / remove | Row |`,
      '| --- | --- | --- |',
      ...group.map((r) => `| \`${r.path}\` | ${lines(r) || '-'} | ${r.rowStatus} |`),
    );
    if (open) out.push('', '</details>');
  }
  const gaps = rows.filter((r) => r.unresolved);
  if (gaps.length) {
    out.push('', '### Imports playerz cannot resolve yet', '');
    for (const r of gaps)
      out.push(`- \`${r.path}\`: ${r.unresolved.map((u) => `\`${u}\``).join(', ')}`);
  }
  const twice = rows.filter((r) => r.alsoAt);
  if (twice.length) {
    out.push(
      '',
      `### inflect keeps these twice (${twice.length})`,
      '',
      'Each is in both src/ and packages/ui/src/ at this commit, and playerz holds one copy. ' +
        'The package one was compared.',
      '',
      ...twice.map(
        (r) => `- \`${r.path}\`: \`${[r.movedTo ?? r.inflectPath, ...r.alsoAt].join('`, `')}\``,
      ),
    );
  }
  const moved = rows.filter((r) => r.movedTo);
  if (moved.length) {
    out.push(
      '',
      `### Moved in inflect (${moved.length})`,
      '',
      'inflect moved these files since their row was written (RodnaPamet/inflect-compliance#3046 ' +
        'moves the shared UI into `packages/ui`). They are compared at the new path above, so a ' +
        'move is not drift. ' +
        `\`${repoint(inflect.short)}\` updates their \`inflectPath\`.`,
      '',
      '<details><summary>Moved rows</summary>',
      '',
      '| Path | Row says | inflect has it at |',
      '| --- | --- | --- |',
      ...moved.map((r) => `| \`${r.path}\` | \`${r.inflectPath}\` | \`${r.movedTo}\` |`),
      '',
      '</details>',
    );
  }
  out.push(
    '',
    `_Generated by \`node scripts/ui-sync/status.mjs --ref ${inflect.short}\`. ` +
      'The upstream-first workflow is in `docs/ui-sync/README.md`._',
    '',
  );
  return out.join('\n');
}

run(main, USAGE);
