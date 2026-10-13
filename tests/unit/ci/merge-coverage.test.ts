import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  findMaps,
  main,
  mergeMaps,
  shortfalls,
  totals,
} from '../../../scripts/ci/merge-coverage.mjs';

/**
 * The Coverage job runs in shards (#542), and the floor is one number over
 * the whole suite: this is the step that puts the shards back together and
 * checks it. It has to be right about two things: a line any shard ran is
 * covered, and anything missing is an error rather than a pass.
 */

/** A file with four statements, one function and one two-armed branch. */
function fileCoverage(path: string, s: number[], f: number, b: [number, number]) {
  const loc = (line: number) => ({ start: { line, column: 0 }, end: { line, column: 10 } });
  return {
    [path]: {
      path,
      statementMap: { 0: loc(1), 1: loc(2), 2: loc(3), 3: loc(4) },
      fnMap: { 0: { name: 'fn', decl: loc(1), loc: loc(1), line: 1 } },
      branchMap: { 0: { type: 'if', loc: loc(2), locations: [loc(2), loc(3)], line: 2 } },
      s: { 0: s[0], 1: s[1], 2: s[2], 3: s[3] },
      f: { 0: f },
      b: { 0: b },
    },
  };
}

describe('merging shards', () => {
  it('a statement any shard ran is covered: halves that each look half-tested add up', () => {
    const first = fileCoverage('/app/a.ts', [1, 1, 0, 0], 1, [1, 0]);
    const second = fileCoverage('/app/a.ts', [0, 0, 1, 1], 0, [0, 1]);
    expect(totals(mergeMaps([first]))).toMatchObject({ statements: 50, branches: 50 });
    expect(totals(mergeMaps([second]))).toMatchObject({ statements: 50, functions: 0 });

    expect(totals(mergeMaps([first, second]))).toEqual({
      statements: 100,
      branches: 100,
      functions: 100,
      lines: 100,
    });
  });

  it('a file only one shard loaded keeps its own numbers, and a file nobody ran counts against the total', () => {
    const tested = fileCoverage('/app/a.ts', [1, 1, 1, 1], 1, [1, 1]);
    const untouched = fileCoverage('/app/b.ts', [0, 0, 0, 0], 0, [0, 0]);
    // Jest lists every file in scope in every shard (collectCoverageFrom), run or not.
    const merged = mergeMaps([{ ...tested, ...untouched }, untouched]);
    expect(merged.files().sort()).toEqual(['/app/a.ts', '/app/b.ts']);
    expect(totals(merged)).toMatchObject({ statements: 50, functions: 50, branches: 50 });
  });
});

describe('the floor', () => {
  const floor = { lines: 80, functions: 80, statements: 80, branches: 72 };

  it('names each metric below it, with both numbers', () => {
    expect(
      shortfalls({ lines: 80, functions: 79.99, statements: 91, branches: 71 }, floor),
    ).toEqual([
      { metric: 'branches', actual: 71, minimum: 72 },
      { metric: 'functions', actual: 79.99, minimum: 80 },
    ]);
    expect(shortfalls({ lines: 80, functions: 80, statements: 80, branches: 72 }, floor)).toEqual(
      [],
    );
  });

  it('a number that is not a number is below the floor, not above it', () => {
    // istanbul reports "Unknown" for a metric with nothing to measure.
    expect(
      shortfalls({ lines: 'Unknown', functions: 90, statements: 90, branches: 90 }, floor),
    ).toEqual([{ metric: 'lines', actual: 'Unknown', minimum: 80 }]);
  });
});

describe('the command', () => {
  let dir: string;
  const logs: string[] = [];
  let log: jest.SpyInstance;
  let err: jest.SpyInstance;
  let cwd: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cov-'));
    cwd = process.cwd();
    logs.length = 0;
    log = jest.spyOn(console, 'log').mockImplementation((m) => void logs.push(String(m)));
    err = jest.spyOn(console, 'error').mockImplementation((m) => void logs.push(String(m)));
  });
  afterEach(() => {
    process.chdir(cwd);
    log.mockRestore();
    err.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  });

  const shard = (name: string, map: object) => {
    mkdirSync(join(dir, name), { recursive: true });
    writeFileSync(join(dir, name, 'coverage-final.json'), JSON.stringify(map));
  };
  const withFloor = (global: object) => {
    writeFileSync(join(dir, 'jest.thresholds.json'), JSON.stringify({ global }));
    process.chdir(dir);
  };

  it('finds each shard’s map wherever the artifact put it', () => {
    shard('coverage-1', {});
    shard('coverage-2/nested', {});
    expect(findMaps(dir).map((f) => f.slice(dir.length + 1))).toEqual([
      'coverage-1/coverage-final.json',
      'coverage-2/nested/coverage-final.json',
    ]);
  });

  it('passes when the shards together meet the floor, though neither does alone', () => {
    shard('coverage-1', fileCoverage('/app/a.ts', [1, 1, 0, 0], 1, [1, 0]));
    shard('coverage-2', fileCoverage('/app/a.ts', [0, 0, 1, 1], 0, [0, 1]));
    withFloor({ lines: 80, functions: 80, statements: 80, branches: 72 });
    expect(main(['.'], { expect: 2 })).toBe(0);
    expect(logs.join('\n')).toContain('merged from 2 run(s)');
  });

  it('fails below the floor, naming the metric', () => {
    shard('coverage-1', fileCoverage('/app/a.ts', [1, 1, 0, 0], 1, [1, 0]));
    shard('coverage-2', fileCoverage('/app/a.ts', [1, 0, 0, 0], 1, [1, 0]));
    withFloor({ lines: 80, functions: 80, statements: 80, branches: 72 });
    expect(main(['.'], { expect: 2 })).toBe(1);
    expect(logs.join('\n')).toMatch(/statements coverage is 50%, below the floor of 80%/);
  });

  it('a missing shard is an error, not a pass on what is left', () => {
    shard('coverage-1', fileCoverage('/app/a.ts', [1, 1, 1, 1], 1, [1, 1]));
    withFloor({ lines: 80 });
    // One perfect map, where two were expected: the other half was never measured.
    expect(main(['.'], { expect: 2 })).toBe(2);
    expect(logs.join('\n')).toContain('Expected 2 coverage map(s), found 1');
  });

  it('no map at all, an unreadable one and an empty one are errors too', () => {
    withFloor({ lines: 80 });
    expect(main(['.'])).toBe(2);

    mkdirSync(join(dir, 'bad'), { recursive: true });
    writeFileSync(join(dir, 'bad', 'coverage-final.json'), '{ not json');
    expect(main(['.'])).toBe(2);

    writeFileSync(join(dir, 'bad', 'coverage-final.json'), '{}');
    expect(main(['.'])).toBe(2);
    expect(logs.join('\n')).toContain('names no file');
  });
});
