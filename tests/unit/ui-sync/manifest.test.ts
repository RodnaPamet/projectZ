/** @jest-environment node */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  MANIFEST_DIR,
  formatInflectPaths,
  formatManifest,
  parseInflectPaths,
  readAllRows,
  readManifest,
  strayManifestFiles,
  writeManifest,
} from '../../../scripts/ui-sync/manifest.mjs';

/**
 * The manifest's file format. The guardrail (tests/guardrails/ui-sync-manifest)
 * checks the rows; this checks that what the scripts write is what they read,
 * and that it is already in the shape the pre-commit hook's prettier writes.
 */

const row = (path: string, extra: Record<string, unknown> = {}) => ({
  sha256: 'f'.repeat(64),
  status: 'pending',
  sha: null,
  baseSha: '1520b8b87',
  inflectPath: path,
  path,
  ...extra,
});

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ui-sync-manifest-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('formatManifest', () => {
  it('sorts rows by path and writes the keys in one fixed order', () => {
    const text = formatManifest([row('src/components/ui/z.tsx'), row('src/components/ui/a.tsx')]);
    const doc = JSON.parse(text);

    expect(doc.rows.map((r: { path: string }) => r.path)).toEqual([
      'src/components/ui/a.tsx',
      'src/components/ui/z.tsx',
    ]);
    // Key order is part of the diff a reviewer reads, so it must not depend on
    // the order an object happened to be built in.
    expect(Object.keys(doc.rows[0])).toEqual([
      'path',
      'inflectPath',
      'baseSha',
      'sha',
      'status',
      'sha256',
    ]);
    expect(text.endsWith('}\n')).toBe(true);
    expect(text).toContain('\n  "rows": [\n    {\n      "path": ');
  });

  it('keeps reason and upstream on a local-diff row, and drops the manifest tag', () => {
    const doc = JSON.parse(
      formatManifest([
        {
          ...row('src/components/ui/a.tsx', { status: 'local-diff' }),
          reason: 'why',
          upstream: 'https://github.com/RodnaPamet/inflect-compliance/pull/1',
          manifest: 'ui',
        },
      ]),
    );
    expect(doc.rows[0].reason).toBe('why');
    expect(doc.rows[0].upstream).toMatch(/pull\/1$/);
    expect(doc.rows[0].manifest).toBeUndefined();
  });
});

describe('reading and writing', () => {
  it('reads back what it wrote, tagged with the manifest name', () => {
    writeManifest(root, 'ui', [row('src/components/ui/a.tsx')]);
    writeManifest(root, 'lib', [row('src/lib/cn.ts')]);

    expect(readManifest(root, 'ui')).toHaveLength(1);
    expect(readAllRows(root).map((r: { manifest: string }) => r.manifest)).toEqual(['ui', 'lib']);
  });

  it('treats an absent manifest as empty, and a malformed one as an error', () => {
    expect(readManifest(root, 'ui')).toEqual([]);
    mkdirSync(join(root, MANIFEST_DIR), { recursive: true });
    writeFileSync(join(root, MANIFEST_DIR, 'ui.json'), '[]');
    expect(() => readManifest(root, 'ui')).toThrow(/"rows" array/);
  });

  it('reports a manifest file no rule reads', () => {
    writeManifest(root, 'ui', []);
    writeFileSync(join(root, MANIFEST_DIR, 'ui-tabel.json'), formatManifest([]));
    expect(strayManifestFiles(root)).toEqual([`${MANIFEST_DIR}/ui-tabel.json`]);
    expect(readFileSync(join(root, MANIFEST_DIR, 'ui.json'), 'utf8')).toContain('"rows": []');
  });
});

describe('inflect-paths.txt', () => {
  it('round-trips: header SHA, sorted unique paths', () => {
    const text = formatInflectPaths({
      sha: 'a'.repeat(40),
      date: '2026-09-29',
      paths: ['src/lib/cn.ts', 'src/components/ui/a.tsx', 'src/lib/cn.ts'],
    });
    expect(parseInflectPaths(text)).toEqual({
      sha: 'a'.repeat(40),
      paths: ['src/components/ui/a.tsx', 'src/lib/cn.ts'],
    });
  });
});
