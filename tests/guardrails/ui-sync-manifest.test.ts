import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import {
  INFLECT_PATHS_FILE,
  PORT_BASE,
  manifestFor,
  parseInflectPaths,
  readAllRows,
  readInflectPaths,
  rowProblems,
  sha256,
  strayManifestFiles,
} from '../../scripts/ui-sync/manifest.mjs';
import { playerzPath } from '../../scripts/ui-sync/inflect-package.mjs';
import { checkRows } from '../../scripts/ui-sync/portable-rules.mjs';

/**
 * A VENDORED FILE CHANGES UPSTREAM FIRST, THEN COMES BACK THROUGH copy.mjs.
 *
 * ═══ WHY ═══
 *
 * playerz's UI primitives are inflect-compliance's. The 2026-07-11 port copied
 * them and nothing recorded that it had, so every later fix was made here, in
 * place. By 44048af, 50 of the 480 shared component files had drifted: 16
 * changed only here, 10 on both sides. A fix made here is a fork; the next
 * re-sync either loses it or has to merge it by hand, file by file.
 *
 * So a fix goes to RodnaPamet/inflect-compliance first, and playerz takes the
 * merged result with `node scripts/ui-sync/copy.mjs --ref <sha> <paths>`, which
 * writes prettier(inflect@sha) and records its sha256 here. Any other edit to
 * a vendored file changes its bytes, and this test says so.
 *
 * ═══ WHAT IT CHECKS ═══
 *
 *   - every manifest row is well-formed and names a file that exists;
 *   - 'pending' and 'vendored' files hash to the recorded sha256;
 *   - every playerz file at a path inflect also has (docs/ui-sync/inflect-paths.txt,
 *     read here because CI has no inflect clone) has a row, so a file copied
 *     by hand cannot pass as playerz's own. An inflect path in its @inflect/ui
 *     package, packages/ui/src/<p>, is the playerz file src/<p>;
 *   - a 'local-diff' row, the only escape hatch, says why and links the
 *     upstream PR or issue that will remove it;
 *   - every 'vendored' file passes check-portable's rules (portable-rules.mjs),
 *     the WHOLE manifest and not only the files a PR copies (#307). A
 *     'pending' row is not checked: those are the 2026-07 port, inflect is
 *     cleaning them up (#3047/#3048), and `check-portable.mjs --manifest
 *     pending` lists what is still upstream-blocked.
 *
 * The drift itself (TAKE, KEEP, MERGE) is not a failure. scripts/ui-sync/status.mjs
 * reports it, and .github/workflows/ui-drift.yml keeps one issue current.
 */

interface Row {
  path: string;
  inflectPath: string;
  baseSha: string;
  sha: string | null;
  status: string;
  sha256: string;
  reason?: string;
  upstream?: string;
  manifest: string;
}

const root = process.cwd();
const ROWS = readAllRows(root) as Row[];
const INFLECT = readInflectPaths(root);

const isFile = (p: string) => existsSync(join(root, p)) && statSync(join(root, p)).isFile();
const readBytes = (p: string) => (isFile(p) ? readFileSync(join(root, p)) : null);

/** Locked rows whose bytes no longer hash to the recorded digest. */
function tampered(rows: Row[], read: (path: string) => Buffer | null): string[] {
  return rows
    .filter((r) => r.status === 'pending' || r.status === 'vendored')
    .filter((r) => {
      const bytes = read(r.path);
      return bytes !== null && sha256(bytes) !== r.sha256;
    })
    .map((r) => r.path);
}

/**
 * Playerz files that sit at an inflect path and have no row. inflect keeps
 * packages/ui/src/<p> where playerz keeps src/<p>, so that is the file looked for.
 */
function unrowed(inflectPaths: string[], rows: Row[], exists: (path: string) => boolean): string[] {
  const rowed = new Set(rows.map((r) => r.path));
  return [...new Set(inflectPaths.map(playerzPath))].filter((p) => exists(p) && !rowed.has(p));
}

describe('the manifest is readable, and the scan is not vacuous', () => {
  it('finds the rows and the inflect path list', () => {
    // 480 shared component files and four lib modules at T09. Far fewer means
    // a manifest went missing or a parse silently returned nothing.
    expect(ROWS.length).toBeGreaterThan(400);
    expect(INFLECT.paths.length).toBeGreaterThan(400);
    expect(INFLECT.sha).toMatch(/^[0-9a-f]{7,40}$/);
  });

  it('has no manifest file that no rule reads', () => {
    // A typo'd ui-tabel.json would hold rows that nothing checks.
    expect(strayManifestFiles(root)).toEqual([]);
  });
});

describe('every row is valid', () => {
  it('is well-formed and filed in the manifest its path belongs to', () => {
    const problems = ROWS.flatMap((r) => rowProblems(r, r.manifest));
    if (problems.length > 0) {
      throw new Error(`Malformed ui-sync manifest rows:\n\n  ${problems.join('\n  ')}`);
    }
  });

  it('names a file that exists', () => {
    const missing = ROWS.filter((r) => !isFile(r.path)).map((r) => r.path);
    if (missing.length > 0) {
      throw new Error(
        `Manifest rows for files that do not exist:\n\n  ${missing.join('\n  ')}\n\n` +
          `A vendored file you delete takes its row with it: move the row to\n` +
          `docs/ui-sync/available.json (create it, a JSON array, if it does not\n` +
          `exist yet), keeping inflectPath and sha.`,
      );
    }
  });

  it('gives each path one row', () => {
    const seen = new Set<string>();
    const twice = ROWS.filter((r) => (seen.has(r.path) ? true : (seen.add(r.path), false)));
    expect(twice.map((r) => r.path)).toEqual([]);
  });

  it('lets a local-diff row stand only with a reason and an upstream link', () => {
    // The escape hatch for an emergency fix. Every one is a fork until the
    // upstream PR it links merges, so it must say which PR that is.
    const problems = ROWS.filter((r) => r.status === 'local-diff').flatMap((r) =>
      rowProblems(r, r.manifest),
    );
    expect(problems).toEqual([]);
  });
});

describe('vendored files are byte-identical to what copy.mjs wrote', () => {
  it('every pending and vendored file still hashes to its recorded sha256', () => {
    const changed = tampered(ROWS, readBytes);
    if (changed.length > 0) {
      throw new Error(
        `${changed.length} vendored file(s) edited in place:\n\n  ${changed.join('\n  ')}\n\n` +
          `These are copies of RodnaPamet/inflect-compliance files. An edit here is a fork\n` +
          `the next re-sync loses or has to merge by hand, so change it upstream, then run\n` +
          `scripts/ui-sync/copy.mjs:\n\n` +
          `  1. open the change as a PR on inflect (run scripts/ui-sync/check-portable.mjs\n` +
          `     over the files first) and merge it;\n` +
          `  2. node scripts/ui-sync/copy.mjs --ref <merged sha> <paths>\n\n` +
          `If it cannot wait, make it a 'local-diff' row with a reason and the upstream link.\n` +
          `The pre-commit hook's eslint --fix can also change a copied file; that fix belongs\n` +
          `upstream too. See docs/ui-sync/README.md.`,
      );
    }
  });
});

interface Finding {
  path: string;
  line: number;
  rule: string;
  text: string;
  status: string;
}

/** check-portable findings in the vendored rows, one `path:line rule text` each. */
function unportable(rows: Row[], read: (path: string) => Buffer | null): string[] {
  const vendored = rows.filter((r) => r.status === 'vendored');
  return (checkRows(vendored, (r: Row) => read(r.path)?.toString('utf8') ?? null) as Finding[]).map(
    (f) => `${f.path}:${f.line}  ${f.rule}  ${f.text}`,
  );
}

describe('every vendored file is portable', () => {
  it('has no check-portable finding in any vendored file', () => {
    // T17 ran check-portable over only the files it copied, so an earlier copy
    // that still said "evidence upload" sat in the tree unflagged (#307).
    expect(ROWS.filter((r) => r.status === 'vendored').length).toBeGreaterThan(0);
    const findings = unportable(ROWS, readBytes);
    if (findings.length > 0) {
      throw new Error(
        `${findings.length} check-portable finding(s) in vendored files:\n\n  ` +
          `${findings.join('\n  ')}\n\n` +
          `These are byte-identical copies of inflect, so the fix is upstream: change the\n` +
          `file in RodnaPamet/inflect-compliance, merge it, then\n\n` +
          `  node scripts/ui-sync/copy.mjs --ref <merged sha> <paths>\n\n` +
          `Do not edit the copy. Reproduce with node scripts/ui-sync/check-portable.mjs\n` +
          `--manifest vendored.`,
      );
    }
  });
});

describe('every playerz file at an inflect path has a row', () => {
  it('leaves no copy unrecorded', () => {
    const missing = unrowed(INFLECT.paths, ROWS, isFile);
    if (missing.length > 0) {
      throw new Error(
        `Files at paths inflect also uses, with no manifest row:\n\n  ${missing.join('\n  ')}\n\n` +
          `A file copied from inflect by hand is invisible to the drift report and to\n` +
          `this lock. Bring it in with node scripts/ui-sync/copy.mjs --ref <sha> <path>,\n` +
          `which writes the row. If it is playerz's own file, move it off inflect's path.`,
      );
    }
  });
});

// ── Negative controls ─────────────────────────────────────────────────
//
// Each check above passes by finding nothing, which is indistinguishable from
// a check that cannot find anything. These feed it the defects it exists for.

describe('the checks fire on the defects they exist for', () => {
  const row = (over: Partial<Row> = {}): Row => ({
    path: 'src/components/ui/button.tsx',
    inflectPath: 'src/components/ui/button.tsx',
    baseSha: PORT_BASE,
    sha: null,
    status: 'pending',
    sha256: sha256(Buffer.from('export const a = 1;\n')),
    manifest: 'ui',
    ...over,
  });

  it('a one-character edit to a pending or vendored file is caught', () => {
    const edited = () => Buffer.from('export const a = 2;\n');
    expect(tampered([row()], edited)).toEqual(['src/components/ui/button.tsx']);
    expect(tampered([row({ status: 'vendored', sha: 'a'.repeat(40) })], edited)).toHaveLength(1);
    // …the untouched file is not, and a local-diff row is not hash-locked at all.
    expect(tampered([row()], () => Buffer.from('export const a = 1;\n'))).toEqual([]);
    expect(tampered([row({ status: 'local-diff' })], edited)).toEqual([]);
  });

  it('a file at an inflect path without a row is caught; one playerz lacks is not', () => {
    const inflectPaths = ['src/components/ui/button.tsx', 'src/components/ui/card.tsx'];
    const has = (p: string) => p === 'src/components/ui/card.tsx';
    expect(unrowed(inflectPaths, [row()], has)).toEqual(['src/components/ui/card.tsx']);
    expect(
      unrowed(inflectPaths, [row(), row({ path: 'src/components/ui/card.tsx' })], has),
    ).toEqual([]);
  });

  it('a file inflect moved into packages/ui is looked for at src/, where playerz keeps it', () => {
    // inflect #3046: the icons now live at packages/ui/src/components/ui/icons/.
    // Read literally, no playerz file is ever at that path and the check passes
    // whatever was copied by hand.
    const moved = ['packages/ui/src/components/ui/icons/copy.tsx'];
    const has = (p: string) => p === 'src/components/ui/icons/copy.tsx';
    expect(unrowed(moved, [], has)).toEqual(['src/components/ui/icons/copy.tsx']);
    expect(unrowed(moved, [row({ path: 'src/components/ui/icons/copy.tsx' })], has)).toEqual([]);
  });

  it('a compliance word in a vendored file is caught; in a pending one it is not', () => {
    const prose = () =>
      Buffer.from('/** Uploads the evidence for a control. */\nexport const a = 1;\n');
    const vendored = row({ status: 'vendored', sha: 'a'.repeat(40) });
    expect(unportable([vendored], prose).join('\n')).toMatch(/button\.tsx:1 {2}vocabulary/);
    expect(unportable([row()], prose)).toEqual([]);
    expect(unportable([vendored], () => Buffer.from('export const a = 1;\n'))).toEqual([]);
  });

  it('a hard-coded screen-reader label in a vendored file is caught, camelCase prop included', () => {
    // inflect #3201: the vendored LocaleSwitcher said ariaLabel="Language", a
    // prop and not the aria-label attribute, so this scan passed it.
    const vendored = row({ status: 'vendored', sha: 'a'.repeat(40) });
    const literal = () =>
      Buffer.from('export const S = () => <ToggleGroup ariaLabel="Language" />;\n');
    expect(unportable([vendored], literal)).toEqual([
      'src/components/ui/button.tsx:1  a11y-copy  ariaLabel="Language"',
    ]);
    const translated = () =>
      Buffer.from("export const S = () => <ToggleGroup ariaLabel={t('language')} />;\n");
    expect(unportable([vendored], translated)).toEqual([]);
  });

  it('a local-diff row without a reason or an upstream link is refused', () => {
    const bare = rowProblems(row({ status: 'local-diff' }), 'ui');
    expect(bare.join('\n')).toMatch(/must say why/);
    expect(bare.join('\n')).toMatch(/must link the inflect PR or issue/);

    const complete = row({
      status: 'local-diff',
      reason: 'hotfix for a focus trap while inflect#3001 is in review',
      upstream: 'https://github.com/RodnaPamet/inflect-compliance/pull/3001',
    });
    expect(rowProblems(complete, 'ui')).toEqual([]);
    // A link to anywhere else is not an upstream link.
    expect(
      rowProblems({ ...complete, upstream: 'https://github.com/RodnaPamet/projectZ/pull/1' }, 'ui'),
    ).toHaveLength(1);
  });

  it('a malformed row is refused', () => {
    expect(rowProblems(row(), 'ui')).toEqual([]);
    expect(rowProblems(row(), 'layout').join()).toMatch(/belongs in docs\/ui-sync\/manifest\/ui/);
    expect(rowProblems(row({ status: 'vendored' }), 'ui').join()).toMatch(
      /records the inflect commit/,
    );
    expect(rowProblems(row({ status: 'copied' }), 'ui').join()).toMatch(/status must be one of/);
    expect(rowProblems(row({ sha256: 'abc' }), 'ui').join()).toMatch(/sha256/);
    expect(rowProblems({ ...row(), reasons: 'typo' } as Row, 'ui').join()).toMatch(/unknown key/);
  });

  it('files each directory in its own manifest', () => {
    expect(manifestFor('src/components/ui/table/table.tsx')).toBe('ui-table');
    expect(manifestFor('src/components/ui/hooks/use-local-storage.ts')).toBe('ui-hooks');
    expect(manifestFor('src/components/ui/icons/nucleo/check2.tsx')).toBe('ui-icons');
    expect(manifestFor('src/components/ui/button.tsx')).toBe('ui');
    expect(manifestFor('src/components/layout/nav-bar.tsx')).toBe('layout');
    expect(manifestFor('src/lib/cn.ts')).toBe('lib');
    // playerz's own directories have no manifest at all.
    expect(manifestFor('src/components/mobile/PullToRefresh.tsx')).toBeNull();
    expect(manifestFor('src/app/page.tsx')).toBeNull();
  });

  it('reads the inflect path list: header SHA, paths, no comments', () => {
    const parsed = parseInflectPaths(
      '# inflect 1c546d442ba3 (2026-09-29)\n#\n# note\nsrc/components/ui/a.tsx\n\nsrc/lib/cn.ts\n',
    );
    expect(parsed).toEqual({
      sha: '1c546d442ba3',
      paths: ['src/components/ui/a.tsx', 'src/lib/cn.ts'],
    });
    // The real file is the one this suite reads.
    expect(readFileSync(join(root, INFLECT_PATHS_FILE), 'utf8')).toMatch(/^# inflect [0-9a-f]{40}/);
  });
});
