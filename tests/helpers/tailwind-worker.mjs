#!/usr/bin/env node
/**
 * Tailwind, compiled OUTSIDE jest (#312).
 *
 * `@tailwindcss/node` calls `module.registerHooks()` when it loads, to teach
 * Node's loader its ESM resolution. Jest 30.5 refuses that call inside a test
 * (jest-runtime #16391: the hooks would attach to the loader running Jest
 * itself, not to the sandboxed modules), so a guardrail that imports Tailwind
 * dies before its first assertion. The guards that need a real Tailwind
 * compile run this file in a plain Node process instead and check its answer.
 * They check exactly what they did before; only where the compile runs moved.
 *
 * Reads one JSON request on stdin, writes one JSON answer on stdout:
 *
 *   node tests/helpers/tailwind-worker.mjs optimize   {css, from} → {warnings}
 *       Every console.warn the optimizer printed while compiling `css`.
 *   node tests/helpers/tailwind-worker.mjs dead       {classes}   → {dead}
 *       The classes that compile to NOTHING against src/app/globals.css.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

const [, , command] = process.argv;
const input = JSON.parse(readFileSync(0, 'utf8') || '{}');

async function optimize({ css, from }) {
  const { default: tailwind } = await import('@tailwindcss/postcss');
  const { default: postcss } = await import('postcss');
  const warnings = [];
  const original = console.warn;
  console.warn = (...args) => warnings.push(args.map(String).join(' '));
  try {
    await postcss([tailwind({ optimize: { minify: false } })]).process(css, { from });
  } finally {
    console.warn = original;
  }
  return { warnings };
}

async function dead({ classes }) {
  const { __unstable__loadDesignSystem } = await import('@tailwindcss/node');
  const globals = path.resolve('src/app/globals.css');
  const ds = await __unstable__loadDesignSystem(readFileSync(globals, 'utf8'), {
    base: path.dirname(globals),
  });
  const css = ds.candidatesToCss(classes);
  return { dead: classes.filter((_, i) => css[i] == null) };
}

const commands = { optimize, dead };
if (!commands[command]) {
  process.stderr.write(`tailwind-worker: unknown command ${JSON.stringify(command)}\n`);
  process.exit(2);
}
process.stdout.write(JSON.stringify(await commands[command](input)));
