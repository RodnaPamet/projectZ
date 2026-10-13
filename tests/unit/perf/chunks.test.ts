import { globSync, readFileSync } from 'node:fs';

import { bytesBySource, chunkTable, decodeMappings, groupOf, projectPath } from '../../perf/chunks';

/**
 * `npm run perf:chunks` (#340): what a route's First Load JS is made of, read
 * from the build's source maps.
 */
describe('decoding a source map’s mappings', () => {
  it('reads segments as absolute columns and absolute source indexes', () => {
    // A segment is [column, source, line, column-in-source], each a delta.
    // "AAAA": column 0, source 0. "KAAA": +5 columns, same source. Then a new
    // line "ACAA" (column back to 0, source +1) and "IAAA" (+4, same source).
    expect(decodeMappings('AAAA,KAAA;ACAA,IAAA')).toEqual([
      [
        [0, 0],
        [5, 0],
      ],
      [
        [0, 1],
        [4, 1],
      ],
    ]);
  });

  it('keeps a segment with no source apart, and an empty line empty', () => {
    // "A" alone is a column with no source; ";;" is two empty lines.
    expect(decodeMappings('A,CAAA;;ACAA')).toEqual([
      [
        [0, -1],
        [1, 0],
      ],
      [],
      [[0, 1]],
    ]);
  });

  it('reads multi-digit and negative values', () => {
    // "gB" is 16; "D" is -1: the source index steps back.
    expect(decodeMappings('ACAA,gBDAA')).toEqual([
      [
        [0, 1],
        [16, 0],
      ],
    ]);
  });

  it('refuses what is not base64 VLQ rather than guessing', () => {
    expect(() => decodeMappings('AA*A')).toThrow(/VLQ/);
  });
});

describe('bytes per source file', () => {
  const js = 'aaaaabbbbbbbccc\ndddddddd';
  const map = {
    sources: ['one.ts', 'two.ts'],
    // Line 1: one.ts from 0, two.ts from 5, one.ts from 12. Line 2: two.ts from 0.
    mappings: 'AAAA,KCAA,ODAA;ACAA',
  };

  it('gives each file the bytes from its segment to the next, and the line’s end to the last', () => {
    expect(Object.fromEntries(bytesBySource(js, map))).toEqual({
      'one.ts': 5 + 3,
      'two.ts': 7 + 8,
      // The line break between them belongs to no file.
      '': 1,
    });
  });

  it('counts what no segment covers as unattributed, so the total is the file’s size', () => {
    const glued = `/*glue*/${js}`;
    const shifted = { sources: map.sources, mappings: 'QAAA,KCAA,ODAA;ACAA' };
    const by = bytesBySource(glued, shifted);
    // 8 bytes of glue before the first segment, and the newline between lines.
    expect(by.get('')).toBe(8 + 1);
    expect([...by.values()].reduce((a, b) => a + b, 0)).toBe(glued.length);
  });

  it('reads an index map: each section at its own offset', () => {
    const by = bytesBySource('xxxxyyyy\nzzzz', {
      sections: [
        { offset: { line: 0, column: 0 }, map: { sources: ['a.ts'], mappings: 'AAAA' } },
        { offset: { line: 1, column: 0 }, map: { sources: ['b.ts'], mappings: 'AAAA' } },
      ],
    });
    expect(by.get('a.ts')).toBe(8);
    expect(by.get('b.ts')).toBe(4);
  });
});

describe('the row a source is counted under', () => {
  it.each([
    ['turbopack:///[project]/node_modules/motion-dom/dist/es/index.mjs', 'npm:motion-dom'],
    [
      'turbopack:///[project]/node_modules/@radix-ui/react-dialog/dist/index.mjs',
      'npm:@radix-ui/react-dialog',
    ],
    // A package nested inside another counts as itself.
    [
      '[project]/node_modules/intl-messageformat/node_modules/@formatjs/icu/lib/a.js',
      'npm:@formatjs/icu',
    ],
    [
      'turbopack:///[project]/src/components/ui/icons/nucleo/arrow-left.tsx',
      'src/components/ui/icons',
    ],
    ['turbopack:///[project]/src/components/ui/sheet.tsx', 'src/components/ui/sheet.tsx'],
    ['turbopack:///[project]/src/lib/data/provider.tsx', 'src/lib/data/provider.tsx'],
    ['turbopack:///[project]/src/app/(home)/ContactForm.tsx', 'src/app/(home)'],
    ['turbopack:///[project]/messages/bg.json', 'messages/bg.json'],
    ['', '(bundler glue, unattributed)'],
  ])('%s → %s', (source, group) => {
    expect(groupOf(source)).toBe(group);
  });

  it('projectPath strips the bundler’s prefix and nothing else', () => {
    expect(projectPath('turbopack:///[project]/src/app/layout.tsx')).toBe('src/app/layout.tsx');
    expect(projectPath('./src/app/layout.tsx')).toBe('src/app/layout.tsx');
  });
});

describe('the table', () => {
  it('shows the top rows, folds the rest into one, and marks gzip as an estimate', () => {
    const table = chunkTable(
      {
        route: '/',
        files: 2,
        rawBytes: 4096,
        gzipBytes: 1024,
        unmappedBytes: 0,
        rows: [
          { name: 'npm:next', bytes: 2048 },
          { name: 'npm:motion-dom', bytes: 1024 },
          { name: 'src/app/(home)', bytes: 1024 },
        ],
      },
      2,
    );
    expect(table).toContain('### `/`: 1.0 KB gzip (4.0 KB minified, 2 files)');
    expect(table).toContain('| 2.0 | 50.0% | ~0.5 | `npm:next` |');
    expect(table).toContain('| 1.0 | 25.0% | ~0.3 | `npm:motion-dom` |');
    expect(table).toContain('| 1.0 | 25.0% | ~0.3 | 1 more rows |');
  });
});

describe('browser source maps never reach an image', () => {
  it('only PERF_SOURCEMAPS=1 turns them on, and nothing that builds for deployment sets it', () => {
    const config = readFileSync('next.config.mjs', 'utf8');
    expect(config).toMatch(/productionBrowserSourceMaps:\s*process\.env\.PERF_SOURCEMAPS === '1'/);
    // A deployed map is the source code, served to anyone who asks.
    const deploying = [
      'Dockerfile',
      ...globSync('.github/workflows/*.yml').map((f) => f.toString()),
      ...globSync('docker-compose*.yml').map((f) => f.toString()),
      ...globSync('ops/*.yml').map((f) => f.toString()),
    ];
    expect(deploying.length).toBeGreaterThan(2);
    const setting = deploying.filter((f) => readFileSync(f, 'utf8').includes('PERF_SOURCEMAPS'));
    expect(setting).toEqual([]);
  });
});
