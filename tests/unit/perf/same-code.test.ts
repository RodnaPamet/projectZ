import { execFileSync } from 'node:child_process';

import { APP_PATHS, appTreeId, sameCodeKeys, type GitInfo } from '../../perf/report';

/**
 * Which perf runs may be pooled (#452): only runs that built the same code.
 */
const run = (over: Partial<GitInfo>): GitInfo => ({
  head: 'aaaaaaa',
  base: 'a0b0d4b',
  branch: 'main',
  dirty: false,
  app: 'app-main',
  ...over,
});

describe('do these runs describe the same code?', () => {
  it('a main run and a branch run rebased on it share a merge base, and are NOT the same code', () => {
    // The case the issue names: a before and an after, both `base: a0b0d4b`.
    const main = run({});
    const branch = run({ head: 'bbbbbbb', branch: 'feat/x', app: 'app-branch' });
    expect(sameCodeKeys([main, branch])).toEqual({ by: 'app', keys: ['app-main', 'app-branch'] });
  });

  it('two branch runs with an app commit between them are not the same code either', () => {
    const first = run({ head: 'b1', branch: 'feat/x', app: 'app-1' });
    const second = run({ head: 'b2', branch: 'feat/x', app: 'app-2' });
    expect(sameCodeKeys([first, second]).keys).toHaveLength(2);
  });

  it('a commit that only touches the harness changes the head and not the app: they pool', () => {
    const first = run({ head: 'h1' });
    const second = run({ head: 'h2' });
    expect(sameCodeKeys([first, second])).toEqual({ by: 'app', keys: ['app-main'] });
  });

  it('a run from before the app id falls back to the merge base, and says so', () => {
    const old = run({ app: undefined });
    const fresh = run({ app: 'app-main' });
    // One run without it is enough: there is nothing to compare its app with.
    expect(sameCodeKeys([old, fresh])).toEqual({ by: 'base', keys: ['a0b0d4b'] });
    expect(sameCodeKeys([run({ app: null, base: null, head: 'h9' })])).toEqual({
      by: 'base',
      keys: ['h9'],
    });
  });
});

describe('the app id', () => {
  it('is a hash of the committed trees the app is made from, the same every time', () => {
    const id = appTreeId();
    expect(id).toMatch(/^[0-9a-f]{12}$/);
    expect(appTreeId()).toBe(id);
  });

  it('covers what a build reads, and not the harness, the tests or the docs', () => {
    expect(APP_PATHS).toEqual(
      expect.arrayContaining(['src', 'prisma', 'messages', 'package-lock.json', 'next.config.mjs']),
    );
    for (const outside of ['tests', 'docs', 'scripts', '.github']) {
      expect(APP_PATHS as readonly string[]).not.toContain(outside);
    }
  });

  it('every path it names exists at HEAD: a renamed file would silently drop out of the hash', () => {
    const present = execFileSync('git', ['ls-tree', '--name-only', 'HEAD', '--', ...APP_PATHS], {
      encoding: 'utf8',
    })
      .trim()
      .split('\n')
      .sort();
    expect(present).toEqual([...APP_PATHS].sort());
  });
});
