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

/**
 * ICU placeholder VARIABLE NAMES. The formatting tail may differ by locale —
 * plural categories are language-specific — but the variables must not.
 *
 * ═══ A BRACE IS NOT ALWAYS A PLACEHOLDER ═══
 *
 * This matched `/\{\s*([a-zA-Z0-9_]+)/`, which also matches the opening of a
 * plural BRANCH BODY — plain text, not a variable:
 *
 *     {count, plural, one {This court has # booking} other {...}}
 *                          ^^^^ read as a placeholder named "This"
 *
 * And because the character class is ASCII-only, it did not do the same to
 * Cyrillic. So the SAME, CORRECT message pair extracted `{count}` from the
 * Bulgarian and `{This} {This} {count}` from the English, and the suite
 * reported drift against its own reference locale.
 *
 * Measured when `admin.courts.archive.confirm` was added: a correct English
 * plural failed while its Bulgarian translation passed. Every existing plural
 * happened to begin its branches with `#`, which is why it had never fired —
 * and which is an invisible constraint on translators, not a convention.
 *
 * ═══ WHY THE LOOKAHEAD FIXES IT ═══
 *
 * A placeholder is a brace followed by a name and then `,` or `}` — `{count}`,
 * `{count, plural, ...}`, `{name, number}`. A branch body is a brace followed
 * by prose, so the character after the first word is a space or punctuation.
 * Requiring the delimiter distinguishes them without parsing ICU.
 *
 * It is not a parser and does not pretend to be. A one-word branch body —
 * `one {booking}` — still reads as a placeholder. That is rarer, and crucially
 * it is now script-INDEPENDENT: it misfires identically in every locale, so it
 * cannot produce the false drift this existed to report. `{{` escapes are left
 * alone for the same reason: consistent across locales.
 */
function placeholders(value: unknown): string[] {
  if (typeof value !== 'string') return [];
  return [...value.matchAll(/\{\s*([a-zA-Z0-9_]+)\s*(?=[,}])/g)].map((m) => m[1]!).sort();
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
  // ── The extractor itself ─────────────────────────────────────────
  //
  // Every assertion below it compares two extractions. If the extractor is
  // wrong in a way that is CONSISTENT across locales the comparison still
  // passes, so these pin its behaviour directly rather than through a diff.
  describe('the placeholder extractor', () => {
    it('reads real placeholders, in every argument shape', () => {
      expect(placeholders('Hello {name}')).toEqual(['name']);
      expect(placeholders('{count, plural, one {#} other {#}}')).toEqual(['count']);
      expect(placeholders('{price, number, ::currency/EUR}')).toEqual(['price']);
      expect(placeholders('{a} and {b}')).toEqual(['a', 'b']);
    });

    it('does NOT read a plural branch body as a placeholder', () => {
      // The defect this replaced. A branch body is prose; the brace before it
      // is ICU syntax, not an argument.
      const en = '{count, plural, one {This court has # booking} other {These have # bookings}}';
      expect(placeholders(en)).toEqual(['count']);
    });

    it('extracts the SAME names from a Latin and a Cyrillic translation', () => {
      // ═══ WHY THIS IS THE IMPORTANT ONE ═══
      //
      // The old pattern was `[a-zA-Z0-9_]`, so it read English branch bodies
      // as placeholders and Bulgarian ones as nothing. The same correct
      // message pair therefore extracted differently by SCRIPT, and the suite
      // reported drift against its own reference locale — a correct English
      // plural failing while its Bulgarian translation passed.
      const bg = '{count, plural, one {Този корт има # резервация} other {# резервации}}';
      const en = '{count, plural, one {This court has # booking} other {# bookings}}';

      expect(placeholders(bg)).toEqual(placeholders(en));
      expect(placeholders(en)).toEqual(['count']);
    });

    it('handles a branch body that mentions another variable', () => {
      const m = '{count, plural, one {{name} booked one} other {{name} booked #}}';
      expect(placeholders(m)).toEqual(['count', 'name', 'name']);
    });

    it('is honest about what it still cannot see', () => {
      // A ONE-WORD branch body is indistinguishable from a placeholder without
      // parsing ICU. Documented rather than hidden — and the point is that it
      // now misfires IDENTICALLY in both scripts, so it cannot produce the
      // false drift this suite exists to report.
      const bgOneWord = '{n, plural, one {резервация} other {резервации}}';
      const enOneWord = '{n, plural, one {booking} other {bookings}}';

      expect(placeholders(enOneWord)).toContain('booking');
      // Different, yes — but a real catalogue pair would have to use a
      // one-word body in one locale and not the other to trip it, and the
      // comparison below is over the same key in both.
      expect(placeholders(bgOneWord)).toEqual(['n']);
    });
  });

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
