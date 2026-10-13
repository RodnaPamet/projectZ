import { execFileSync } from 'node:child_process';
import path from 'node:path';

/**
 * Ask a plain Node process to compile Tailwind (tests/helpers/tailwind-worker.mjs).
 * Jest 30.5 refuses `@tailwindcss/node`'s `module.registerHooks()` inside a
 * test (#312), so the compile runs outside the sandbox and only its JSON
 * answer comes back in.
 */
const WORKER = path.resolve(__dirname, 'tailwind-worker.mjs');
const ROOT = path.resolve(__dirname, '../..');

function ask<T>(command: 'optimize' | 'dead', request: unknown): T {
  const out = execFileSync(process.execPath, [WORKER, command], {
    cwd: ROOT,
    input: JSON.stringify(request),
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return JSON.parse(out) as T;
}

/** Every console.warn Tailwind's optimizer printed while compiling `css`. */
export function tailwindWarnings(css: string, from: string): string[] {
  return ask<{ warnings: string[] }>('optimize', { css, from }).warnings;
}

/** The classes that compile to nothing against src/app/globals.css. */
export function deadClasses(classes: string[]): string[] {
  return ask<{ dead: string[] }>('dead', { classes }).dead;
}
