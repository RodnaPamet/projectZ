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
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import { UsageError, parseCli, run } from './cli.mjs';
import { checkSource } from './portable-rules.mjs';

const USAGE = `Usage: node scripts/ui-sync/check-portable.mjs [--root <dir>] <file> ...`;

async function main() {
  const { flags, positionals } = parseCli(process.argv.slice(2), { values: ['root'] });
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
  const width = Math.max(...findings.map((f) => `${f.path}:${f.line}`.length));
  for (const f of findings) {
    console.log(`${`${f.path}:${f.line}`.padEnd(width)}  ${f.rule.padEnd(16)}  ${f.text}`);
  }
  const files = new Set(findings.map((f) => f.path)).size;
  console.log(
    `\ncheck-portable: ${findings.length} finding(s) in ${files} file(s). Each would fail a ` +
      `playerz guardrail once copied; fix them here before opening the upstream PR.`,
  );
  process.exitCode = 1;
}

run(main, USAGE);
