/**
 * Can this inflect file be copied into playerz as it is?
 *
 *   node <playerz>/scripts/ui-sync/check-portable.mjs --root <inflect worktree> <files...>
 *
 * Runs playerz's guardrail rules (portable-rules.mjs) over files in ANOTHER
 * checkout, typically an inflect worktree about to open an upstream PR. Paths
 * are relative to --root (default: the current directory). Prints one line per
 * finding and exits 1 if there are any, 0 when the files are portable, 2 on a
 * usage error.
 *
 * Over the whole manifest instead of named files:
 *
 *   node scripts/ui-sync/check-portable.mjs --manifest vendored
 *     Every 'vendored' row's playerz file. Exits 1 on any finding. The same
 *     scan runs in tests/guardrails/ui-sync-manifest.test.ts, so CI fails too.
 *
 *   node scripts/ui-sync/check-portable.mjs --manifest pending [--ref <inflect rev>]
 *     Every 'pending' row: a report, always exit 0. These are inflect's to fix
 *     (#3047/#3048) before the next batch copies them. Without --ref it reads
 *     the playerz copies (the 2026-07 port); with --ref it reads each row's
 *     inflectPath at that inflect commit ($INFLECT_DIR), which is what a copy
 *     would bring in.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import { UsageError, parseCli, run } from './cli.mjs';
import { REPO_ROOT, inflectDir, normalise, readInflectFiles, resolveRev } from './lib.mjs';
import { readAllRows } from './manifest.mjs';
import { checkRows, checkSource } from './portable-rules.mjs';

const USAGE = `Usage: node scripts/ui-sync/check-portable.mjs [--root <dir>] <file> ...
       node scripts/ui-sync/check-portable.mjs --manifest vendored
       node scripts/ui-sync/check-portable.mjs --manifest pending [--ref <inflect rev>]`;

function print(findings) {
  const width = Math.max(...findings.map((f) => `${f.path}:${f.line}`.length));
  for (const f of findings) {
    console.log(`${`${f.path}:${f.line}`.padEnd(width)}  ${f.rule.padEnd(16)}  ${f.text}`);
  }
  return new Set(findings.map((f) => f.path)).size;
}

async function manifestMode(status, ref) {
  if (status !== 'vendored' && status !== 'pending') {
    throw new UsageError(`--manifest takes vendored or pending, not "${status}".`);
  }
  if (ref && status !== 'pending') throw new UsageError('--ref applies to --manifest pending.');
  const rows = readAllRows(REPO_ROOT).filter((r) => r.status === status);

  let read;
  let source;
  if (ref) {
    const dir = inflectDir();
    const sha = resolveRev(dir, ref, 'inflect');
    // Wherever inflect keeps each file at that commit, src/ or packages/ui/src/.
    const files = readInflectFiles(
      dir,
      rows.map((r) => [sha, r.inflectPath]),
    );
    const texts = new Map();
    for (const r of rows) {
      const text = files.get(`${sha}:${r.inflectPath}`)?.text;
      texts.set(r.path, text == null ? null : await normalise(text, r.path));
    }
    read = (r) => texts.get(r.path);
    source = `inflect ${sha.slice(0, 9)}`;
    // A row inflect no longer has is skipped, not passed: say how many, or a
    // scan that read nothing reads as "0 findings".
    const absent = rows.filter((r) => texts.get(r.path) == null).length;
    if (absent) source += `; ${absent} not in inflect there, so not checked`;
  } else {
    read = (r) => {
      const abs = join(REPO_ROOT, r.path);
      return existsSync(abs) ? readFileSync(abs, 'utf8') : null;
    };
    source = 'playerz';
  }

  const findings = checkRows(rows, read);
  if (findings.length === 0) {
    console.log(`check-portable: ${rows.length} ${status} file(s) (${source}), 0 findings.`);
    return;
  }
  const files = print(findings);
  if (status === 'vendored') {
    console.log(
      `\ncheck-portable: ${findings.length} finding(s) in ${files} of ${rows.length} vendored ` +
        `file(s). Fix them in inflect and re-copy with copy.mjs; never edit the copy.`,
    );
    process.exitCode = 1;
  } else {
    console.log(
      `\ncheck-portable: ${findings.length} finding(s) in ${files} of ${rows.length} pending ` +
        `file(s) (${source}). Upstream-blocked: inflect fixes these (#3047/#3048) before ` +
        `they are copied. Not a failure.`,
    );
  }
}

async function main() {
  const { flags, positionals } = parseCli(process.argv.slice(2), {
    values: ['root', 'manifest', 'ref'],
  });
  if (flags.manifest !== undefined) {
    if (positionals.length > 0 || flags.root) {
      throw new UsageError('--manifest reads the manifest; it takes no files and no --root.');
    }
    return manifestMode(flags.manifest, flags.ref);
  }
  if (flags.ref) throw new UsageError('--ref applies to --manifest pending.');
  if (positionals.length === 0) throw new UsageError('Name at least one file.');
  const root = resolve(flags.root ?? '.');

  const findings = [];
  for (const arg of positionals) {
    // Accept paths relative to --root, or absolute/cwd-relative ones inside it.
    const abs = resolve(root, arg);
    const path = relative(root, abs).split('\\').join('/');
    if (!existsSync(abs)) throw new UsageError(`${path}: no such file under ${root}`);
    findings.push(...checkSource(path, readFileSync(join(root, path), 'utf8')));
  }

  if (findings.length === 0) {
    console.log(`check-portable: ${positionals.length} file(s) portable.`);
    return;
  }
  const files = print(findings);
  console.log(
    `\ncheck-portable: ${findings.length} finding(s) in ${files} file(s). Each would fail a ` +
      `playerz guardrail once copied; fix them here before opening the upstream PR.`,
  );
  process.exitCode = 1;
}

run(main, USAGE);
