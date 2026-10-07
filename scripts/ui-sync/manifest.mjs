/**
 * THE UI-SYNC MANIFEST: WHICH PLAYERZ FILES ARE COPIES OF INFLECT FILES.
 *
 * playerz's UI primitives came from inflect-compliance: 58a6ebd copied inflect
 * 1520b8b87 on 2026-07-11. By 2026-09-27, 430 of the 480 component paths the two
 * repos share were still identical once both sides went through the same
 * prettier, and the other 50 had drifted three ways: 21 changed only upstream,
 * 16 only here, 10 on both sides, 3 at the port itself. Nothing recorded which
 * file was a copy, so nothing stopped a local edit, and every local edit was a
 * fork nobody would ever merge back.
 *
 * Each row here names one copy and locks it by hash. A change goes upstream
 * first (a PR to RodnaPamet/inflect-compliance) and comes back through
 * `scripts/ui-sync/copy.mjs`; tests/guardrails/ui-sync-manifest.test.ts fails on
 * anything else. See docs/ui-sync/README.md.
 *
 * ═══ WHY THIS FILE IMPORTS NOTHING BUT node: MODULES ═══
 *
 * The guardrail imports it under jest, which runs CommonJS through SWC. Prettier
 * 3 and its Tailwind plugin are ESM-only and `import.meta` does not survive the
 * transform, so both live in lib.mjs, which only the CLI scripts load.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** The inflect commit the 2026-07-11 port (playerz 58a6ebd) copied. */
export const PORT_BASE = '1520b8b87';

/** The playerz commit that made that port; `status.mjs --port` attributes against it. */
export const PORT_COMMIT = '58a6ebd';

export const MANIFEST_DIR = 'docs/ui-sync/manifest';
export const INFLECT_PATHS_FILE = 'docs/ui-sync/inflect-paths.txt';

/** The rows of vendored files playerz deleted, kept so a file can be copied back. */
export const AVAILABLE_FILE = 'docs/ui-sync/available.json';

/**
 * The component directories kept in step with inflect. A playerz file at an
 * inflect path under one of these must have a row.
 *
 * `filters` holds one shared file (FilterToolbar.tsx). It was part of the
 * 480-path measurement and T28 moves its row to available.json when it deletes
 * the file, so it is tracked like the rest.
 *
 * These are playerz paths. In inflect each one is also read under
 * packages/ui/src/ (inflect-package.mjs), where inflect #3046 is moving them.
 */
export const SYNCED_DIRS = [
  'src/components/ui',
  'src/components/layout',
  'src/components/theme',
  'src/components/nav',
  'src/components/filters',
];

/**
 * One manifest per directory, so parallel PRs that vendor different parts of
 * the tree write different files. First match wins.
 *
 * `lib` holds only the UI modules the vendored components need (cn,
 * theme-constants, the keyboard-shortcut registry, …). The rest of src/lib that
 * also exists upstream (auth, security, observability) is playerz's own code now
 * and is deliberately NOT locked.
 */
const MANIFEST_RULES = [
  ['src/components/ui/table/', 'ui-table'],
  ['src/components/ui/hooks/', 'ui-hooks'],
  ['src/components/ui/icons/', 'ui-icons'],
  ['src/components/ui/', 'ui'],
  ['src/components/layout/', 'layout'],
  ['src/components/theme/', 'theme'],
  ['src/components/nav/', 'nav'],
  ['src/components/filters/', 'filters'],
  ['src/lib/', 'lib'],
];

export const MANIFEST_NAMES = [...new Set(MANIFEST_RULES.map(([, name]) => name))];

/**
 * pending    Came from the 2026-07-11 port and has not been re-synced yet. Its
 *            bytes are locked all the same: it changes upstream first.
 * vendored   Written by copy.mjs; equals prettier(inflect@sha) byte for byte.
 * local-diff The one escape hatch. Differs from upstream on purpose, and must
 *            say why and link the upstream PR or issue that removes the need.
 */
export const ROW_STATUSES = ['pending', 'vendored', 'local-diff'];

const ROW_KEYS = [
  'path',
  'inflectPath',
  'baseSha',
  'sha',
  'status',
  'sha256',
  'reason',
  'upstream',
];
const SHA = /^[0-9a-f]{7,40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const UPSTREAM = /^https:\/\/github\.com\/RodnaPamet\/inflect-compliance\/(?:pull|issues)\/\d+$/;

const ABOUT =
  'Written by scripts/ui-sync (copy.mjs, paths.mjs), never by hand: a vendored file ' +
  'changes upstream first and comes back through copy.mjs. See docs/ui-sync/README.md.';

/** The manifest a repo-relative path belongs in, or null when none covers it. */
export function manifestFor(path) {
  for (const [prefix, name] of MANIFEST_RULES) if (path.startsWith(prefix)) return name;
  return null;
}

export function manifestFile(name) {
  return `${MANIFEST_DIR}/${name}.json`;
}

export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Rows of one manifest; an absent file is an empty manifest. */
export function readManifest(root, name) {
  const file = join(root, manifestFile(name));
  if (!existsSync(file)) return [];
  const doc = JSON.parse(readFileSync(file, 'utf8'));
  if (!doc || !Array.isArray(doc.rows)) {
    throw new Error(`${manifestFile(name)}: expected an object with a "rows" array`);
  }
  return doc.rows;
}

/** Every row of every manifest, each tagged with the manifest it came from. */
export function readAllRows(root) {
  return MANIFEST_NAMES.flatMap((name) =>
    readManifest(root, name).map((row) => ({ ...row, manifest: name })),
  );
}

/** Manifest files on disk that no rule writes to: a typo'd name would be read by nothing. */
export function strayManifestFiles(root) {
  const dir = join(root, MANIFEST_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .filter((f) => !MANIFEST_NAMES.includes(f.slice(0, -'.json'.length)))
    .map((f) => `${MANIFEST_DIR}/${f}`);
}

/**
 * Serialise one manifest. Rows sorted by path, keys in a fixed order, two-space
 * JSON: exactly what prettier writes for it, so the pre-commit hook's
 * `prettier --write` leaves the file alone.
 */
export function formatManifest(rows) {
  const ordered = [...rows]
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((row) => {
      const out = {};
      for (const key of ROW_KEYS) if (row[key] !== undefined) out[key] = row[key];
      return out;
    });
  return `${JSON.stringify({ about: ABOUT, rows: ordered }, null, 2)}\n`;
}

export function writeManifest(root, name, rows) {
  mkdirSync(join(root, MANIFEST_DIR), { recursive: true });
  writeFileSync(join(root, manifestFile(name)), formatManifest(rows));
}

/** Everything wrong with one row, as sentences. Empty means valid. */
export function rowProblems(row, manifest) {
  const problems = [];
  const at = typeof row.path === 'string' ? row.path : JSON.stringify(row);

  for (const key of Object.keys(row)) {
    if (key !== 'manifest' && !ROW_KEYS.includes(key)) problems.push(`${at}: unknown key "${key}"`);
  }
  if (typeof row.path !== 'string' || row.path.split('/').includes('..')) {
    problems.push(`${at}: path must be a repo-relative path`);
  } else if (manifestFor(row.path) !== manifest) {
    problems.push(`${at}: belongs in ${manifestFile(manifestFor(row.path))}, not ${manifest}`);
  }
  if (typeof row.inflectPath !== 'string' || row.inflectPath.length === 0) {
    problems.push(`${at}: inflectPath is required`);
  }
  if (typeof row.baseSha !== 'string' || !SHA.test(row.baseSha)) {
    problems.push(`${at}: baseSha must be an inflect commit SHA`);
  }
  if (!ROW_STATUSES.includes(row.status)) {
    problems.push(`${at}: status must be one of ${ROW_STATUSES.join(', ')}`);
  }
  if (row.sha !== null && (typeof row.sha !== 'string' || !SHA.test(row.sha))) {
    problems.push(`${at}: sha must be an inflect commit SHA or null`);
  }
  if (row.status === 'vendored' && row.sha === null) {
    problems.push(`${at}: a vendored row records the inflect commit it was copied from`);
  }
  if (typeof row.sha256 !== 'string' || !SHA256.test(row.sha256)) {
    problems.push(`${at}: sha256 must be the hex digest of the committed bytes`);
  }
  if (row.status === 'local-diff') {
    if (typeof row.reason !== 'string' || row.reason.trim().length < 10) {
      problems.push(`${at}: a local-diff row must say why it differs from upstream (reason)`);
    }
    if (typeof row.upstream !== 'string' || !UPSTREAM.test(row.upstream)) {
      problems.push(
        `${at}: a local-diff row must link the inflect PR or issue that removes it ` +
          `(upstream: https://github.com/RodnaPamet/inflect-compliance/pull/<n>)`,
      );
    }
  }
  return problems;
}

/** available.json's rows, in file order; an absent file is an empty list. */
export function readAvailable(root) {
  const file = join(root, AVAILABLE_FILE);
  if (!existsSync(file)) return [];
  const rows = JSON.parse(readFileSync(file, 'utf8'));
  if (!Array.isArray(rows)) throw new Error(`${AVAILABLE_FILE}: expected a JSON array of rows`);
  return rows;
}

/** Two-space JSON, as prettier writes it, with the rows in the order given. */
export function writeAvailable(root, rows) {
  writeFileSync(join(root, AVAILABLE_FILE), `${JSON.stringify(rows, null, 2)}\n`);
}

/** docs/ui-sync/inflect-paths.txt: `# inflect <sha>` header lines, then one path per line. */
export function parseInflectPaths(text) {
  const sha = /^#\s*inflect\s+([0-9a-f]{7,40})\b/m.exec(text)?.[1] ?? null;
  const paths = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
  return { sha, paths };
}

export function readInflectPaths(root) {
  const file = join(root, INFLECT_PATHS_FILE);
  if (!existsSync(file)) return { sha: null, paths: [] };
  return parseInflectPaths(readFileSync(file, 'utf8'));
}

export function formatInflectPaths({ sha, date, paths }) {
  return [
    `# inflect ${sha} (${date})`,
    '#',
    '# Every inflect path under src/components/{ui,layout,theme,nav,filters} at that',
    '# commit, plus the src/lib modules playerz vendors, and the same under',
    '# packages/ui/src/ (the @inflect/ui package, inflect #3046). playerz keeps',
    '# packages/ui/src/<p> at src/<p>. A playerz file at any of these paths must have',
    '# a row in docs/ui-sync/manifest (tests/guardrails/ui-sync-manifest).',
    '# Regenerate with: node scripts/ui-sync/paths.mjs --ref <sha> --write',
    ...[...new Set(paths)].sort(),
    '',
  ].join('\n');
}
