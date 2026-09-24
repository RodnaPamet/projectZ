/**
 * The four-project test spine.
 *
 *   unit         — jsdom, pure logic + helpers. Fast, no I/O.
 *   unit-tz      — the timezone-sensitive subset. Run TWICE by `test:tz`,
 *                  once from a host west of Greenwich and once from one east.
 *   rendered     — jsdom + RTL, component smoke.
 *   integration  — node, REAL Postgres + Redis. Serial (see maxWorkers).
 *   guardrails   — node, structural scans over the source tree.
 *
 * ─── The coverageThreshold trap ──────────────────────────────────────
 *
 * P03's prompt puts `coverageThreshold` at the TOP LEVEL alongside
 * `projects`. In multi-project mode jest SILENTLY IGNORES it — the run
 * exits 0 no matter how far below the floor coverage actually is. The port
 * source hit exactly this and documents it: their thresholds were
 * "documented but NEVER enforced" until enforcement moved to the CLI.
 *
 * So we do both:
 *   1. thresholds live INSIDE the project blocks, where they are honoured; and
 *   2. `jest.thresholds.json` is the single source of truth that the CI
 *      coverage gate passes via `--coverageThreshold`, which IS enforced.
 *
 * A guardrail (`test-infra-integrity`) asserts the top-level key stays
 * absent, so nobody "helpfully" moves it back.
 */
import { readFileSync } from 'node:fs';

const thresholds = JSON.parse(readFileSync(new URL('./jest.thresholds.json', import.meta.url)));

// Packages that ship pure ESM. Jest does not transform node_modules by
// default, so their bare `export` statements are a SyntaxError in the CJS
// test runtime. Add only with a reproduction.
const ESM_PACKAGES = [
  'next-intl',
  'use-intl',
  // The FormatJS chain under use-intl: intl-messageformat pulls
  // @formatjs/{icu-messageformat-parser,fast-memoize,ecma402-abstract,…}.
  'intl-messageformat',
  '@formatjs/[^/]+',
  // MSW and its interceptors ship ESM-only.
  'msw',
  // @t3-oss/env-nextjs (and the env-core it wraps) are "type": "module" with no
  // CJS entry. src/env.ts imports it at module load, so ANY test that reaches
  // src/lib/errors/types.ts — which imports @/env — dies on a parse error that
  // names errors/types.ts rather than the package. Reproduction: importing
  // toApiErrorResponse from a unit test.
  '@t3-oss/[^/]+',
  // tournament-organizer is ESM-only, and so is the pairing engine it pulls in.
  // A nested ESM dep that is not named here stays untransformed and the parser
  // dies on its first `import` — the failure names the PARENT file, which sends
  // you looking in the wrong place.
  'tournament-organizer',
  'tournament-pairings',
  '@mswjs/[^/]+',
  '@bundled-es-modules/[^/]+',
  'until-async',
  'strict-event-emitter',
  'rettime',
  'outvariant',
  'headers-polyfill',
  '@open-draft/[^/]+',
  // sanitize-html pulls an ESM htmlparser2, which pulls the whole
  // dom* family — each in a NESTED node_modules, so every one of them
  // has to be named.
  'sanitize-html',
  'htmlparser2',
  'domelementtype',
  'domhandler',
  'domutils',
  'dom-serializer',
  'entities',
  'boolbase',
  'css-select',
  'css-what',
  'nth-check',
  'parse-srcset',
  'postcss',
  'picocolors',
  'source-map-js',
  'is-plain-object',
  'deepmerge',
  'escape-string-regexp',
  'klona',
  'is-node-process',
  'graphql',
  'tough-cookie',
  'psl',
].join('|');

// The components use the automatic JSX runtime (no `import React`), so swc
// must be told — its default is the classic runtime, which fails with
// "React is not defined" at the first JSX node.
const SWC_TRANSFORM = [
  '@swc/jest',
  {
    jsc: {
      parser: { syntax: 'typescript', tsx: true },
      transform: { react: { runtime: 'automatic' } },
    },
    // Emit CommonJS. Jest's runtime is CJS, and a dependency whose package.json
    // says `"type": "module"` is otherwise left as ESM — which then throws
    // "Cannot use import statement outside a module" from inside node_modules.
    module: { type: 'commonjs' },
  },
];

const common = {
  moduleNameMapper: { '^@/(.*)$': '<rootDir>/src/$1' },
  // `.mjs` MUST be in the pattern. MSW's ESM deps (rettime, outvariant)
  // ship .mjs — allowlisting them in transformIgnorePatterns does nothing
  // if the transform itself never matches the extension.
  transform: { '^.+\\.(m|c)?[tj]sx?$': SWC_TRANSFORM },
  transformIgnorePatterns: [`/node_modules/(?!(?:${ESM_PACKAGES})/)`],
};

const config = {
  projects: [
    {
      ...common,
      displayName: 'unit',
      testEnvironment: 'jsdom',
      testMatch: ['<rootDir>/tests/unit/**/*.test.ts?(x)'],
      setupFilesAfterEnv: ['<rootDir>/jest.setup.ts'],
      coverageThreshold: thresholds,
    },
    {
      ...common,
      displayName: 'rendered',
      testEnvironment: 'jsdom',
      testMatch: ['<rootDir>/tests/rendered/**/*.test.ts?(x)'],
      setupFilesAfterEnv: ['<rootDir>/jest.setup.ts', '<rootDir>/tests/helpers/rtl-setup.ts'],
    },
    {
      ...common,
      displayName: 'integration',
      testEnvironment: 'node',
      testMatch: ['<rootDir>/tests/integration/**/*.test.ts'],
      setupFilesAfterEnv: ['<rootDir>/jest.setup.ts', '<rootDir>/tests/helpers/db-setup.ts'],
      // Serial. resetDatabase() TRUNCATEs — a parallel worker would wipe
      // another worker's rows mid-test.
      maxWorkers: 1,
      coverageThreshold: thresholds,
    },
    {
      ...common,
      displayName: 'guardrails',
      testEnvironment: 'node',
      testMatch: ['<rootDir>/tests/guardrails/**/*.test.ts'],
    },

    // ─── The timezone-sensitive subset ───────────────────────────────
    //
    // A server-timezone bug is DIRECTIONAL. Reading a `@db.Date` column
    // through local accessors instead of UTC ones only disagrees from a host
    // WEST of Greenwich; building a day key with `toISOString()` instead of
    // local fields only disagrees from one EAST. A suite pinned to either
    // direction is blind to the other, and a suite pinned to neither runs on
    // whatever the developer's laptop happens to be — which is what this was.
    //
    // So these run twice, in both directions, via `npm run test:tz`. The zone
    // is set by the SHELL, before Node starts, because that is the only thing
    // that works:
    //
    //   - `process.env.TZ = ...` inside a test is inert. Node caches the zone
    //     and jest's sandboxed `process` never triggers a tzset. Measured:
    //     assigning Pacific/Honolulu left `resolvedOptions().timeZone`
    //     reporting the host's own zone and `getHours()` unchanged.
    //   - a `globalSetup` assignment DOES take effect, and leaks: globalSetup
    //     runs in the parent process, so pinning there re-timezones every
    //     OTHER project in the same run. It broke an unrelated DST test.
    {
      ...common,
      displayName: 'unit-tz',
      testEnvironment: 'jsdom',
      testMatch: ['<rootDir>/tests/unit-tz/**/*.test.ts?(x)'],
      setupFilesAfterEnv: ['<rootDir>/jest.setup.ts'],
      // No coverageThreshold: this duplicates coverage of the same source as
      // `unit`, and a second floor over the same files means nothing.
    },
  ],

  // ─── What the coverage floor applies to ────────────────────────────
  //
  // The AUTHORED domain logic, not the ported infrastructure.
  //
  // Most of src/lib is infrastructure copied verbatim from
  // inflect-compliance (observability, storage, rate-limit, csp, cors…). It
  // is tested upstream, in the repo that owns it. Counting it here would
  // drag the number from 88% to 23% and say nothing true about THIS
  // codebase — and the only way to "fix" it would be to write tests for
  // somebody else's already-tested code, which is theatre.
  //
  // The scope below is exactly the code P04–P11 wrote: the booking, pricing,
  // availability, refund and session use cases; the RLS middleware and
  // pg-error mapping; Glicko-2; the permission model; and the auth guards.
  // That is where a regression actually costs something, and it sits at ~88%.
  collectCoverageFrom: [
    // ── Phase 1 ──
    'src/app-layer/usecases/**/*.ts',
    'src/app-layer/repositories/**/*.ts',
    'src/lib/db/**/*.ts',
    'src/lib/matchmaking/**/*.ts',
    'src/lib/auth/**/*.ts',
    'src/lib/permissions.ts',
    'src/lib/security/password-check.ts',
    'src/lib/security/route-permissions.ts',

    // ── Phase 2 ──
    //
    // Added in P24. Every one of these is AUTHORED domain logic — money,
    // ratings, brackets, moderation policy — and none of it was inside the
    // coverage gate. A floor that only measures the code you wrote first is a
    // floor that rises while the uncovered surface grows underneath it.
    'src/lib/billing/**/*.ts',
    'src/lib/gamification/**/*.ts',
    'src/lib/ratings/**/*.ts',
    'src/lib/tournaments/**/*.ts',
    'src/lib/moderation/**/*.ts',
    'src/lib/sports/**/*.ts',
    'src/lib/wearables/**/*.ts',
    'src/lib/push/**/*.ts',
    'src/lib/design/contrast.ts',

    '!**/*.d.ts',
    '!**/index.ts',
  ],
  coveragePathIgnorePatterns: ['/node_modules/', '/tests/', '\\.d\\.ts$'],
};

export default config;
