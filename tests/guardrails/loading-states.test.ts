import { globSync, readFileSync } from 'node:fs';

import bg from '../../messages/bg.json';
import en from '../../messages/en.json';

/**
 * EVERY LOADING STATE IS ANNOUNCED, TRANSLATED, AND NEVER MISTAKEN FOR CONTENT.
 *
 * A skeleton is a grid of grey bars. To a screen reader, without help, it is
 * nothing at all: the page goes silent between the tap and the content. And
 * the easy fix, `<p>Loading…</p>`, is English on a Bulgarian site and the
 * very string i18n-no-hardcoded-copy exists to keep out.
 *
 * So every loading.tsx renders `RouteSkeleton`, which carries the contract
 * once: `role="status"`, `aria-busy="true"` and a visually hidden
 * `common.loading` from the catalogue. This test holds each loading.tsx to
 * that wrapper and the wrapper to the contract; tests/rendered/route-skeleton
 * renders every one of them and checks the result.
 *
 * It also keeps two things OUT of a skeleton: an `h1`, and `data-perf-ready`.
 * The perf harness decides a page has arrived when `main h1` and its
 * `[data-perf-ready]` element are on screen (docs/perf/README.md); a skeleton
 * carrying either would be timed as the content it stands in for.
 */

const WRAPPER = 'src/components/loading/route-skeleton.tsx';
const LOADING = globSync('src/app/**/loading.tsx')
  .map((f) => f.toString())
  .sort();
const SKELETON_SOURCES = [...LOADING, ...globSync('src/components/loading/**/*.tsx').map(String)];

const read = (f: string) => readFileSync(f, 'utf8');
/** Comments are prose about the code, not the code. */
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

describe('the RouteSkeleton wrapper', () => {
  const src = code(read(WRAPPER));

  it('is a live status region that says it is busy', () => {
    expect(src).toMatch(/role="status"/);
    expect(src).toMatch(/aria-busy="true"/);
  });

  it('labels itself from the catalogue, not from JSX', () => {
    expect(src).toMatch(/useTranslations\('common'\)/);
    expect(src).toMatch(/t\('loading'\)/);
    expect(bg.common.loading).toMatch(/\S/);
    expect(en.common.loading).toMatch(/\S/);
  });
});

describe('loading.tsx files', () => {
  it('exist (a glob that matched nothing would pass everything below)', () => {
    expect(LOADING.length).toBeGreaterThanOrEqual(11);
  });

  it.each(LOADING)('%s renders RouteSkeleton', (file) => {
    const src = code(read(file));
    expect(src).toMatch(/import \{ RouteSkeleton \} from '@\/components\/loading\/route-skeleton'/);
    expect(src).toMatch(/export default function \w+\(\) \{\s*return \(\s*<RouteSkeleton[\s>]/);
  });
});

describe('skeleton sources', () => {
  it.each(SKELETON_SOURCES)('%s has no bare "Loading" copy', (file) => {
    // Literal copy in any language. The label is RouteSkeleton's, from the catalogue.
    expect(code(read(file))).not.toMatch(/Loading…|Loading\.\.\.|Зареждане/);
  });

  it.each(SKELETON_SOURCES)('%s carries no h1 and no READY marker', (file) => {
    const src = code(read(file));
    expect(src).not.toMatch(/<h1[\s>]/);
    expect(src).not.toMatch(/data-perf-ready/);
  });
});
