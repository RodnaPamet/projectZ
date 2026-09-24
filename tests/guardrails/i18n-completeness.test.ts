import { readFileSync, globSync } from 'node:fs';

/**
 * EVERY LOCALE CARRIES EVERY KEY, WITH THE SAME PLACEHOLDERS.
 *
 * Ported from agri-saas, where this has been keeping two catalogues honest.
 *
 * Drift accumulates fast in i18n: a feature ships in one language, the
 * translation pass slips, and the UI silently renders the KEY NAME in
 * production — `venues.empty.title` where a sentence belongs. Nothing fails,
 * because next-intl's fallback for a missing key is the key itself.
 *
 * Three failure modes:
 *
 *   MISSING — a key in the reference catalogue and not in another. The common
 *     one, and what a feature PR introduces.
 *
 *   ORPHAN — a key in another catalogue and not in the reference. Usually a
 *     stale rename: the English key was refactored and the old translation
 *     left behind, so a translator maintains a string nothing renders.
 *
 *   PLACEHOLDER DRIFT — the same key with different `{var}` tokens between
 *     locales. next-intl silently fails to interpolate when they disagree,
 *     leaving a raw `{count}` on the page.
 *
 * ═══ WHY BULGARIAN IS THE REFERENCE ═══
 *
 * agri-saas compares against `en.json`. Here it is `bg.json`, because
 * Bulgarian is the default and the language every user sees unless they ask
 * otherwise — so it is the one that must never have a hole. A missing English
 * key shows English-speaking users a key name; a missing Bulgarian key shows
 * it to everybody.
 */

const REFERENCE = 'bg';
const MESSAGES = 'messages';

type Flat = Map<string, unknown>;

function flatten(obj: Record<string, unknown>, prefix = '', out: Flat = new Map()): Flat {
  for (const [k, v] of Object.entries(obj)) {
    const dotted = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      flatten(v as Record<string, unknown>, dotted, out);
    } else {
      out.set(dotted, v);
    }
  }
  return out;
}

/** ICU placeholder VARIABLE NAMES. The formatting tail may differ by locale —
 *  plural categories are language-specific — but the variables must not. */
function placeholders(value: unknown): string[] {
  if (typeof value !== 'string') return [];
  return [...value.matchAll(/\{\s*([a-zA-Z0-9_]+)/g)].map((m) => m[1]!).sort();
}

function read(locale: string): Flat {
  return flatten(JSON.parse(readFileSync(`${MESSAGES}/${locale}.json`, 'utf8')));
}

const catalogues = globSync(`${MESSAGES}/*.json`).map((f) =>
  f
    .toString()
    .replace(/^.*\//, '')
    .replace(/\.json$/, ''),
);

const reference = read(REFERENCE);
const others = catalogues.filter((l) => l !== REFERENCE);

describe('i18n catalogue completeness', () => {
  it('found the catalogues, and the reference has content', () => {
    // A broken glob, or a reference that failed to parse into anything, makes
    // every comparison below trivially true.
    expect(catalogues).toContain(REFERENCE);
    expect(others.length).toBeGreaterThanOrEqual(1);
    expect(reference.size).toBeGreaterThan(50);
  });

  it.each(others)('%s has no MISSING keys', (locale) => {
    const theirs = read(locale);
    const missing = [...reference.keys()].filter((k) => !theirs.has(k));

    if (missing.length > 0) {
      throw new Error(
        `${locale}.json is missing ${missing.length} key(s) that ${REFERENCE}.json has:\n\n` +
          missing.map((k) => `  ${k}\n    ${REFERENCE}: ${String(reference.get(k))}`).join('\n') +
          `\n\nnext-intl renders the KEY NAME when a key is absent, so this ships as\n` +
          `\`venues.empty.title\` on the page rather than as a failure.`,
      );
    }
  });

  it.each(others)('%s has no ORPHAN keys', (locale) => {
    const theirs = read(locale);
    const orphans = [...theirs.keys()].filter((k) => !reference.has(k));

    if (orphans.length > 0) {
      throw new Error(
        `${locale}.json has ${orphans.length} key(s) that ${REFERENCE}.json does not:\n\n` +
          orphans.map((k) => `  ${k}`).join('\n') +
          `\n\nUsually a stale rename — a translator is maintaining a string that\n` +
          `nothing renders.`,
      );
    }
  });

  it.each(others)('%s interpolates the same variables', (locale) => {
    const theirs = read(locale);

    const drifted = [...reference.entries()]
      .filter(([k]) => theirs.has(k))
      .map(([k, v]) => ({ k, ref: placeholders(v), theirs: placeholders(theirs.get(k)) }))
      .filter(({ ref, theirs: t }) => ref.join(',') !== t.join(','));

    if (drifted.length > 0) {
      throw new Error(
        `Placeholder drift in ${locale}.json:\n\n` +
          drifted
            .map(
              ({ k, ref, theirs: t }) =>
                `  ${k}\n    ${REFERENCE}: {${ref.join('} {')}}\n    ${locale}: {${t.join('} {')}}`,
            )
            .join('\n') +
          `\n\nnext-intl does not interpolate a variable the string does not name —\n` +
          `the raw \`{token}\` reaches the page.`,
      );
    }
  });
});
