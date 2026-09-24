import { readFileSync, globSync } from 'node:fs';

/**
 * A DEPENDENCY NOBODY IMPORTS IS NOT FREE.
 *
 * It is:
 *
 *   • SUPPLY-CHAIN SURFACE. It runs its install scripts, it sits in the lockfile,
 *     and it is one compromised maintainer away from being a problem — for code
 *     that does nothing.
 *
 *   • NOISE. It shows up in `npm audit`, in licence scans, and in a permanent
 *     stream of Dependabot PRs about a package nobody uses. Ten such PRs teach
 *     people to ignore Dependabot, which is how the ONE that mattered gets missed.
 *
 * This ratchet exists because exactly that happened: `isomorphic-dompurify`,
 * `@stripe/stripe-js` and `@stripe/react-stripe-js` were all installed, all
 * unimported, and all generating major-version PRs.
 *
 * ─── What it does NOT do ─────────────────────────────────────────────
 *
 * It does not try to be a general unused-dependency detector. Plenty of legitimate
 * dependencies are never `import`ed: a Jest reporter named in a CLI flag, a
 * PostCSS plugin named in a config, a type package consumed only by the compiler.
 * A naive scanner flags all of those, and a ratchet with false positives is a
 * ratchet people disable.
 *
 * So it checks a NAMED LIST of packages that must stay imported-or-gone, and
 * anything genuinely config-only is declared as such, in writing, here.
 */

const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as {
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  scripts: Record<string, string>;
};

const SOURCE = [
  ...globSync('src/**/*.{ts,tsx}'),
  ...globSync('tests/**/*.{ts,tsx}'),
  ...globSync('scripts/**/*.{ts,mjs,js}'),
  ...globSync('*.{mjs,ts}'),
].map((f) => f.toString());

const ALL_SOURCE = SOURCE.map((f) => readFileSync(f, 'utf8')).join('\n');

/**
 * Config files where a package can be named without ever being imported.
 *
 * `package.json` IS NOT ONE OF THEM, and used to be. Every dependency appears
 * in package.json as its own key — `"nanoid": "^6.0.1"` — so the
 * `CONFIG.includes('"' + name + '"')` escape below matched EVERY package, and
 * this rule could not fail for any input. It reported green while 12 runtime
 * dependencies went unimported, which is exactly the Dependabot-noise problem
 * the docblock above describes.
 */
const CONFIG = [
  'next.config.mjs',
  'jest.config.mjs',
  'tailwind.config.ts',
  'eslint.config.mjs',
  'postcss.config.mjs',
]
  .filter((f) => globSync(f).length > 0)
  .map((f) => readFileSync(f, 'utf8'))
  .join('\n');

/**
 * Unimported, and NOT legitimate — a shrinking list, not an allowlist.
 *
 * These were invisible for as long as the `package.json` escape hatch existed.
 * They are recorded rather than deleted because each is waiting on a feature
 * somebody intends to build: `resend` and `bullmq` are the transport and the
 * queue that several half-built features are documented as using.
 *
 * Three came off the list by being REMOVED rather than explained — glicko2
 * (superseded by openskill), jsonwebtoken (APNs signs with node:crypto) and
 * nanoid (ids come from cuid()). Those were not unbuilt features, they were
 * leftovers, and a leftover on an allowlist is just a slower deletion.
 *
 * The tests below make this list self-cleaning. An entry that becomes imported
 * FAILS, and an entry removed from package.json FAILS, so the only way to
 * silence either is to delete the line. It cannot rot into a dumping ground
 * the way a plain allowlist does.
 */
const KNOWN_UNUSED: Record<string, string> = {
  '@tanstack/react-query': 'no data-fetching layer written yet',
  bullmq: 'the job queue the notification and sweep docs describe; nothing enqueues',
  'canvas-confetti': 'gamification UI, unbuilt',
  'driver.js': 'onboarding tour, unbuilt',
  'maplibre-gl': 'the venue map, unbuilt — geo search exists server-side only',
  'p-retry': 'no retry wrapper written',
  'react-map-gl': 'the React wrapper for the venue map, also unbuilt',
  resend: 'the mailer for split payment links and booking email; no sender exists',
  superjson: 'no RPC boundary that needs it',
};

/**
 * Packages that are legitimately never imported. Each one has to say WHY, so the
 * list cannot quietly become a dumping ground for things somebody could not be
 * bothered to remove.
 */
const CONFIG_ONLY: Record<string, string> = {
  'jest-junit': 'a Jest reporter, named on the CLI in the test:ci script',
  '@swc/jest': 'the Jest transform, named in jest.config.mjs',
  prettier: 'run as a binary by lint-staged',
  'lint-staged': 'run by the pre-commit hook',
  husky: 'installs the git hooks on postinstall',
  tsx: 'a binary used to run TypeScript scripts',
  'dotenv-cli': 'a binary used by the test scripts',
  typescript: 'the compiler, invoked as tsc',
  tailwindcss: 'the CSS engine, driven by the PostCSS config',
  autoprefixer: 'a PostCSS plugin',
  postcss: 'the CSS pipeline, driven by postcss.config',
  eslint: 'the linter, invoked as a binary',
  '@playwright/test': 'the e2e runner',
  prisma: 'the migration/generate CLI, run as a binary',
};

function isImported(name: string): boolean {
  // `from 'pkg'`, `from 'pkg/sub'`, `require('pkg')`, `import('pkg')`.
  const escaped = name.replace(/[/\\^$*+?.()|[\]{}]/g, '\\$&');
  const pattern = new RegExp(`from\\s+['"]${escaped}(?:/[^'"]*)?['"]|require\\(\\s*['"]${escaped}`);

  return pattern.test(ALL_SOURCE);
}

describe('the scan is not vacuous', () => {
  it('found the source tree', () => {
    expect(SOURCE.length).toBeGreaterThan(50);
    expect(ALL_SOURCE.length).toBeGreaterThan(10_000);
  });
});

describe('every runtime dependency is actually used', () => {
  const runtime = Object.keys(pkg.dependencies ?? {});

  it('there are runtime dependencies to check', () => {
    expect(runtime.length).toBeGreaterThan(10);
  });

  it('none is unimported and undeclared', () => {
    const orphans = runtime.filter((name) => {
      if (name in CONFIG_ONLY) return false;
      if (name in KNOWN_UNUSED) return false;
      if (isImported(name)) return false;
      // A `@types/*` package is consumed by the compiler, never imported.
      if (name.startsWith('@types/')) return false;
      // Named in a config file rather than imported — legitimate, but it has to
      // appear SOMEWHERE.
      if (CONFIG.includes(`"${name}"`) || CONFIG.includes(`'${name}'`)) return false;

      return true;
    });

    if (orphans.length > 0) {
      throw new Error(
        `Runtime dependencies that nothing imports:\n\n` +
          orphans.map((o) => `  ${o}`).join('\n') +
          `\n\nA dependency nobody imports is not free. It is supply-chain surface for code\n` +
          `that does nothing, and it generates a permanent stream of Dependabot PRs about\n` +
          `a package nobody uses — which teaches people to ignore Dependabot, and that is\n` +
          `how the ONE that mattered gets missed.\n\n` +
          `Remove it, or — if it is genuinely used from a config file or as a binary — add\n` +
          `it to CONFIG_ONLY in this file WITH A REASON.`,
      );
    }
  });
});

describe('the packages we deliberately removed stay removed', () => {
  // Each of these was installed, unimported, and generating major-version PRs.
  // If one comes back, it should come back because somebody actually needs it —
  // and then this list is the place they argue for it.
  it.each([
    ['isomorphic-dompurify', 'we sanitise with sanitize-html (src/lib/security/sanitize.ts)'],
    ['@stripe/stripe-js', 'there is no client-side payment form. Re-add it when one is built.'],
    ['@stripe/react-stripe-js', 'same — no Stripe Elements anywhere in the app.'],
  ])('%s is not a dependency', (name) => {
    const all = { ...pkg.dependencies, ...pkg.devDependencies };

    expect(Object.keys(all)).not.toContain(name);
  });
});

describe('the CONFIG_ONLY escape hatch is honest', () => {
  it('every entry gives a reason', () => {
    for (const [name, reason] of Object.entries(CONFIG_ONLY)) {
      expect(reason.length).toBeGreaterThan(10);
      expect(name).toBeTruthy();
    }
  });

  it('nothing on the list has been removed from package.json without being removed here', () => {
    // A stale allowlist entry is a hole nobody can see. If the package is gone,
    // the exemption should go with it.
    const all = { ...pkg.dependencies, ...pkg.devDependencies };
    const stale = Object.keys(CONFIG_ONLY).filter((name) => !(name in all));

    expect(stale).toEqual([]);
  });
});

describe('the KNOWN_UNUSED ratchet only shrinks', () => {
  const runtime = Object.keys(pkg.dependencies ?? {});

  it('every entry is still a runtime dependency', () => {
    // Removed from package.json but left here = a stale line that silently
    // re-opens the hole if somebody reinstalls that package later.
    const stale = Object.keys(KNOWN_UNUSED).filter((name) => !runtime.includes(name));
    expect(stale).toEqual([]);
  });

  it('every entry is still unimported — importing one means deleting its line', () => {
    // The whole point. The day somebody writes the mailer, `resend` becomes
    // imported and this fails, forcing the line out. Without this the list
    // would be indistinguishable from a permanent exemption.
    const nowUsed = Object.keys(KNOWN_UNUSED).filter((name) => isImported(name));
    expect(nowUsed).toEqual([]);
  });

  it('every entry says why it is still installed', () => {
    // Reported by NAME, so a bare "unused" tells you which line to rewrite.
    const unexplained = Object.entries(KNOWN_UNUSED)
      .filter(([, reason]) => reason.trim().length <= 15)
      .map(([name]) => name);

    expect(unexplained).toEqual([]);
  });

  it('the list has not grown', () => {
    // A number, deliberately. A new unimported dependency has to come past a
    // human editing this line downward-only.
    expect(Object.keys(KNOWN_UNUSED)).toHaveLength(9);
  });
});

describe('the rule can actually fail', () => {
  it('a name that is imported nowhere is not silently excused', () => {
    // The regression guard. `package.json` was in CONFIG, so every dependency
    // matched the config escape and NOTHING could ever be reported — the suite
    // was green by construction. This asserts the two predicates that decide a
    // verdict still discriminate.
    expect(isImported('this-package-does-not-exist-anywhere')).toBe(false);
    expect(CONFIG.includes('"next"')).toBe(false);

    // And that a real import IS seen, so the above is not passing because
    // `isImported` returns false for everything.
    expect(isImported('next')).toBe(true);
  });
});
