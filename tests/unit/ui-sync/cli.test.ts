/** @jest-environment node */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { formatManifest } from '../../../scripts/ui-sync/manifest.mjs';

/**
 * The ui-sync CLIs end to end, the way an agent runs them: real Node ESM, real
 * git, this repo's real prettier. A fixture inflect repository gets a base
 * commit and a later one; a fixture playerz tree starts from the base with
 * local edits. Every verdict status.mjs can give appears once, and copy.mjs
 * must turn a TAKE into IDENTICAL with a row the guardrail accepts.
 *
 * The later commit also does what inflect #3046 does: it moves two files into
 * packages/ui/src/ (one of them changed on the way), and rewrites a file that
 * stays in src/ to import the moved one as `@inflect/ui/<path>`. playerz keeps
 * all three at src/, and none of them may come out GONE.
 *
 * Slow for a unit test (each CLI loads prettier, ~0.5 s), so it is one file
 * that shares its fixtures.
 */
jest.setTimeout(120_000);

const SCRIPTS = join(process.cwd(), 'scripts/ui-sync');
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const sha256 = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync(
    'git',
    [
      '-c',
      'user.name=ui-sync',
      '-c',
      'user.email=ui-sync@example.invalid',
      '-c',
      'commit.gpgsign=false',
      ...args,
    ],
    { cwd, encoding: 'utf8', env: GIT_ENV },
  );
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout.trim();
}

function write(root: string, files: Record<string, string>) {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
}

let tmp: string;
let inflect: string;
let playerz: string;
let base: string;
let later: string;

function cli(script: string, args: string[], cwd = playerz) {
  const r = spawnSync(process.execPath, [join(SCRIPTS, script), ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...GIT_ENV, INFLECT_DIR: inflect },
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

function status(...paths: string[]) {
  const json = join(tmp, 'status.json');
  const r = cli('status.mjs', ['--root', playerz, '--ref', later, '--json', json, ...paths]);
  expect(r.code).toBe(0);
  const report = JSON.parse(readFileSync(json, 'utf8'));
  return Object.fromEntries(
    report.rows.map((row: { path: string; status: string; unresolved?: string[] }) => [
      row.path.replace('src/components/ui/', ''),
      row.unresolved ? `${row.status} ${row.unresolved.join(',')}` : row.status,
    ]),
  );
}

const manifestRows = (name: string) =>
  JSON.parse(readFileSync(join(playerz, `docs/ui-sync/manifest/${name}.json`), 'utf8')).rows;

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'ui-sync-cli-'));
  inflect = join(tmp, 'inflect');
  playerz = join(tmp, 'playerz');

  // inflect: double quotes and its own line breaks, as upstream writes them.
  mkdirSync(inflect);
  git(inflect, 'init', '-q');
  write(inflect, {
    'src/components/ui/same.tsx': 'export const same = "same";\n',
    'src/components/ui/take.tsx': 'export const take = "one";\n',
    'src/components/ui/keep.tsx': 'export const keep = "one";\n',
    'src/components/ui/merge.tsx': 'export const merge = "one";\nexport const other = "one";\n',
    'src/components/ui/gone.tsx': 'export const gone = "one";\n',
    'src/components/ui/moved.tsx': 'export const moved = "one";\n',
    'src/components/ui/moved-take.tsx': 'export const movedTake = "one";\n',
    'src/components/ui/uses-moved.tsx':
      'import { moved } from "./moved";\nexport const usesMoved = moved;\n',
    'src/app/page.tsx': 'export default function Page() { return null; }\n',
  });
  git(inflect, 'add', '.');
  git(inflect, 'commit', '-q', '-m', 'base');
  base = git(inflect, 'rev-parse', 'HEAD');

  write(inflect, {
    'src/components/ui/take.tsx':
      'import { helper } from "./helper";\nexport const take = helper("two");\n',
    'src/components/ui/merge.tsx': 'export const merge = "two";\nexport const other = "one";\n',
    'src/components/ui/table/extra.ts': 'export const extra = { a: 1 };\n',
    'src/components/ui/table/GUIDE.md': '# How the tables work\n',
    // inflect #3046: moved into the package, one of them changed on the way;
    // the file left in src/ imports the moved one by its package name.
    'packages/ui/src/components/ui/moved.tsx': 'export const moved = "one";\n',
    'packages/ui/src/components/ui/moved-take.tsx':
      'import { moved } from "./moved";\nexport const movedTake = moved;\n',
    'src/components/ui/uses-moved.tsx':
      'import { moved } from "@inflect/ui/components/ui/moved";\nexport const usesMoved = moved;\n',
  });
  for (const f of ['gone.tsx', 'moved.tsx', 'moved-take.tsx'])
    rmSync(join(inflect, 'src/components/ui', f));
  git(inflect, 'add', '-A');
  git(inflect, 'commit', '-q', '-m', 'later');
  later = git(inflect, 'rev-parse', 'HEAD');

  // playerz: the base, as prettier writes it here, plus local edits to two files.
  const files: Record<string, string> = {
    'src/components/ui/same.tsx': "export const same = 'same';\n",
    'src/components/ui/take.tsx': "export const take = 'one';\n",
    'src/components/ui/keep.tsx': "export const keep = 'local';\n",
    'src/components/ui/merge.tsx': "export const merge = 'one';\nexport const other = 'local';\n",
    'src/components/ui/gone.tsx': "export const gone = 'one';\n",
    'src/components/ui/moved.tsx': "export const moved = 'one';\n",
    'src/components/ui/moved-take.tsx': "export const movedTake = 'one';\n",
    'src/components/ui/uses-moved.tsx':
      "import { moved } from './moved';\nexport const usesMoved = moved;\n",
  };
  write(playerz, { ...files, 'package.json': '{ "name": "fixture", "dependencies": {} }\n' });
  write(playerz, {
    'docs/ui-sync/manifest/ui.json': formatManifest(
      Object.entries(files).map(([path, text]) => ({
        path,
        inflectPath: path,
        baseSha: base,
        sha: null,
        status: 'pending',
        sha256: sha256(text),
      })),
    ),
  });
});

afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe('status.mjs', () => {
  it('gives each row its three-way verdict, formatting aside', () => {
    // same.tsx differs from inflect only in quote style: IDENTICAL, not drift.
    expect(status()).toEqual({
      'same.tsx': 'IDENTICAL',
      'take.tsx': 'TAKE ./helper',
      'keep.tsx': 'KEEP',
      'merge.tsx': 'MERGE',
      'gone.tsx': 'GONE',
      // Moved into packages/ui: read there, so a move alone is not drift…
      'moved.tsx': 'IDENTICAL',
      'moved-take.tsx': 'TAKE',
      // …and `@inflect/ui/components/ui/moved` is src/components/ui/moved here,
      // so it is not an import playerz lacks.
      'uses-moved.tsx': 'TAKE',
    });
  });

  it('says where inflect moved a file, and how to re-point its row', () => {
    const json = join(tmp, 'moved.json');
    const r = cli('status.mjs', ['--root', playerz, '--ref', later, '--json', json]);
    expect(r.out).toContain(`moved into packages/ui/src/ since their row was written: 2`);
    expect(r.out).toContain(`node scripts/ui-sync/paths.mjs --ref ${later.slice(0, 9)} --repoint`);
    const report = JSON.parse(readFileSync(json, 'utf8'));
    expect(report.moved).toBe(2);
    expect(
      report.rows
        .filter((row: { movedTo?: string }) => row.movedTo)
        .map((row: { path: string; movedTo: string }) => [row.path, row.movedTo]),
    ).toEqual([
      ['src/components/ui/moved-take.tsx', 'packages/ui/src/components/ui/moved-take.tsx'],
      ['src/components/ui/moved.tsx', 'packages/ui/src/components/ui/moved.tsx'],
    ]);
  });

  it('narrows to a path prefix, and writes the drift-issue Markdown', () => {
    expect(Object.keys(status('src/components/ui/keep'))).toEqual(['keep.tsx']);

    const md = join(tmp, 'drift.md');
    expect(cli('status.mjs', ['--root', playerz, '--ref', later, '--markdown', md]).code).toBe(0);
    const text = readFileSync(md, 'utf8');
    expect(text).toContain('| TAKE | 3 |');
    expect(text).toContain('| GONE | 1 |');
    expect(text).toContain('### MERGE (1)');
    expect(text).toContain('`src/components/ui/take.tsx`: `./helper`');
    expect(text).toContain('### Moved in inflect (2)');
    expect(text).toContain(
      '| `src/components/ui/moved.tsx` | `src/components/ui/moved.tsx` | ' +
        '`packages/ui/src/components/ui/moved.tsx` |',
    );
  });

  it('refuses a revision inflect does not have, and says how to get it', () => {
    const r = cli('status.mjs', ['--root', playerz, '--ref', 'no-such-ref']);
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/fetch origin/);
  });
});

describe('copy.mjs', () => {
  it('writes prettier(inflect) at the same path and locks it in the manifest', () => {
    const r = cli('copy.mjs', ['--root', playerz, '--ref', later, 'src/components/ui/take.tsx']);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/changed\s+src\/components\/ui\/take\.tsx/);
    expect(r.out).toMatch(/take\.tsx: \.\/helper/); // the import it still needs

    const bytes = readFileSync(join(playerz, 'src/components/ui/take.tsx'));
    // This repo's .prettierrc: single quotes.
    expect(bytes.toString()).toBe(
      "import { helper } from './helper';\nexport const take = helper('two');\n",
    );
    expect(
      manifestRows('ui').find((row: { path: string }) => row.path.endsWith('/take.tsx')),
    ).toEqual({
      path: 'src/components/ui/take.tsx',
      inflectPath: 'src/components/ui/take.tsx',
      baseSha: later,
      sha: later,
      status: 'vendored',
      sha256: sha256(bytes),
    });
    expect(status()['take.tsx']).toBe('IDENTICAL');
  });

  it('copies a file inflect moved into packages/ui to its src/ path, by its old path', () => {
    const r = cli('copy.mjs', [
      '--root',
      playerz,
      '--ref',
      later,
      'src/components/ui/moved-take.tsx',
      'src/components/ui/uses-moved.tsx',
    ]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(
      /changed\s+src\/components\/ui\/moved-take\.tsx\s+\(inflect has it at packages\/ui\/src\/components\/ui\/moved-take\.tsx\)/,
    );
    // `@inflect/ui/components/ui/moved` resolves to playerz's src/ copy.
    expect(r.out).not.toMatch(/cannot resolve/);

    expect(readFileSync(join(playerz, 'src/components/ui/moved-take.tsx'), 'utf8')).toBe(
      "import { moved } from './moved';\nexport const movedTake = moved;\n",
    );
    expect(readFileSync(join(playerz, 'src/components/ui/uses-moved.tsx'), 'utf8')).toBe(
      "import { moved } from '@inflect/ui/components/ui/moved';\nexport const usesMoved = moved;\n",
    );
    expect(
      manifestRows('ui').find((row: { path: string }) => row.path.endsWith('moved-take.tsx')),
    ).toMatchObject({
      path: 'src/components/ui/moved-take.tsx',
      inflectPath: 'packages/ui/src/components/ui/moved-take.tsx',
      sha: later,
      status: 'vendored',
    });
    expect(status()['moved-take.tsx']).toBe('IDENTICAL');
    expect(status()['uses-moved.tsx']).toBe('IDENTICAL');
  });

  it('copies the code under a directory into its own manifest, never the docs', () => {
    const r = cli('copy.mjs', ['--root', playerz, '--ref', later, 'src/components/ui/table']);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/new\s+src\/components\/ui\/table\/extra\.ts/);
    expect(existsSync(join(playerz, 'src/components/ui/table/GUIDE.md'))).toBe(false);
    expect(manifestRows('ui-table').map((row: { path: string }) => row.path)).toEqual([
      'src/components/ui/table/extra.ts',
    ]);
  });

  it('refuses without --ref, and outside the vendored directories', () => {
    expect(cli('copy.mjs', ['--root', playerz, 'src/components/ui/take.tsx']).code).toBe(2);

    // One bad path refuses the whole call: merge.tsx, listed first, is not
    // written either, so no file is left out of step with its row.
    const merge = readFileSync(join(playerz, 'src/components/ui/merge.tsx'), 'utf8');
    const outside = cli('copy.mjs', [
      '--root',
      playerz,
      '--ref',
      later,
      'src/components/ui/merge.tsx',
      'src/app/page.tsx',
    ]);
    expect(outside.code).toBe(2);
    expect(outside.out).toMatch(/outside every manifest/);
    expect(existsSync(join(playerz, 'src/app/page.tsx'))).toBe(false);
    expect(readFileSync(join(playerz, 'src/components/ui/merge.tsx'), 'utf8')).toBe(merge);
  });
});

describe('paths.mjs', () => {
  it('re-points the row of a file inflect moved, and nothing else about it', () => {
    const before = manifestRows('ui').find((row: { path: string }) =>
      row.path.endsWith('/moved.tsx'),
    );
    expect(before.inflectPath).toBe('src/components/ui/moved.tsx');

    const r = cli('paths.mjs', ['--root', playerz, '--ref', later, '--repoint']);
    expect(r.code).toBe(0);
    // moved-take.tsx was re-pointed by its copy above; moved.tsx is the one left.
    expect(r.out).toContain('re-pointed 1 row(s) in docs/ui-sync/manifest/ui.json');
    expect(
      manifestRows('ui').find((row: { path: string }) => row.path.endsWith('/moved.tsx')),
    ).toEqual({ ...before, inflectPath: 'packages/ui/src/components/ui/moved.tsx' });
    // Its baseSha predates the move; the base is still found, at the old path.
    expect(status()['moved.tsx']).toBe('IDENTICAL');
    expect(cli('status.mjs', ['--root', playerz, '--ref', later]).out).not.toContain('moved');
    // Against a commit from before the move, both re-pointed rows are read at
    // src/, and that is not advice to re-point them back.
    const old = cli('status.mjs', ['--root', playerz, '--ref', base]).out;
    expect(old).toContain('still at their src/ path in this inflect commit: 2');
    expect(old).not.toContain('--repoint');
  });

  it('lists inflect paths, finds a hand-copied file, and can give it a pending row', () => {
    writeFileSync(join(playerz, 'src/components/ui/table/hand-copied.ts'), 'export const x = 1;\n');
    // One copied from inside the package: playerz keeps it at src/ all the same.
    writeFileSync(join(playerz, 'src/components/ui/pkg-copied.tsx'), 'export const y = 1;\n');
    write(inflect, {
      'src/components/ui/table/hand-copied.ts': 'export const x = 1;\n',
      'packages/ui/src/components/ui/pkg-copied.tsx': 'export const y = 1;\n',
    });
    git(inflect, 'add', '-A');
    git(inflect, 'commit', '-q', '-m', 'hand-copied');

    const r = cli('paths.mjs', [
      '--root',
      playerz,
      '--ref',
      'HEAD',
      '--write',
      '--add-pending',
      '--base',
      base,
    ]);
    expect(r.code).toBe(0);
    expect(r.out).toContain('no row: src/components/ui/table/hand-copied.ts');
    expect(r.out).toContain('no row: src/components/ui/pkg-copied.tsx');

    const listed = readFileSync(join(playerz, 'docs/ui-sync/inflect-paths.txt'), 'utf8');
    expect(listed).toContain('\nsrc/components/ui/table/GUIDE.md\n');
    expect(listed).toContain('\npackages/ui/src/components/ui/moved.tsx\n');
    expect(listed).not.toContain('src/app/page.tsx');
    expect(
      manifestRows('ui-table').find((row: { path: string }) => row.path.endsWith('hand-copied.ts')),
    ).toMatchObject({ status: 'pending', baseSha: base, sha: null });
    expect(
      manifestRows('ui').find((row: { path: string }) => row.path.endsWith('pkg-copied.tsx')),
    ).toMatchObject({
      path: 'src/components/ui/pkg-copied.tsx',
      inflectPath: 'packages/ui/src/components/ui/pkg-copied.tsx',
      status: 'pending',
    });
  });
});

describe('check-portable.mjs', () => {
  beforeAll(() => {
    write(tmp, {
      'upstream/src/components/ui/bad.tsx':
        '// ported from Inflect\nexport const Bad = () => <p className="text-gray-500">Evidence list</p>;\n',
      'upstream/src/components/ui/good.tsx':
        'export const Good = ({ label }: { label: string }) => <p>{label}</p>;\n',
    });
  });

  it('exits 1 and names each finding, relative to --root', () => {
    const r = cli('check-portable.mjs', [
      '--root',
      join(tmp, 'upstream'),
      'src/components/ui/bad.tsx',
    ]);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/src\/components\/ui\/bad\.tsx:1\s+vocabulary\s+Inflect/);
    expect(r.out).toMatch(/bad\.tsx:2\s+raw-palette\s+text-gray-500/);
    expect(r.out).toMatch(/bad\.tsx:2\s+english-copy\s+Evidence list/);
  });

  it('exits 0 on a portable file and 2 on a missing one', () => {
    const upstream = join(tmp, 'upstream');
    expect(cli('check-portable.mjs', ['--root', upstream, 'src/components/ui/good.tsx']).code).toBe(
      0,
    );
    expect(cli('check-portable.mjs', ['--root', upstream, 'src/components/ui/nope.tsx']).code).toBe(
      2,
    );
  });
});
