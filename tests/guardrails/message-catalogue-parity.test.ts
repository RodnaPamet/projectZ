import { readFileSync } from 'node:fs';

/**
 * bg AND en SAY THE SAME THINGS.
 *
 * The storefront is Bulgarian: `src/lib/i18n/request.ts` resolves bg, and every
 * user-facing string a Bulgarian player sees comes from messages/bg.json.
 *
 * A key present in en.json and missing from bg.json does not throw. next-intl
 * falls back, so the Bulgarian user is shown ENGLISH — or, depending on
 * configuration, the raw key: `login.submit` rendered on a button.
 *
 * Neither fails a build, neither appears in a log, and neither is visible to
 * anyone developing in English. It surfaces as a support message from a
 * customer, which is the most expensive place to find it.
 *
 * The sport registry already has a cross-walk for exactly this reason
 * (`sport-registry-completeness`). This generalises it to the whole catalogue.
 */

type Catalogue = Record<string, unknown>;

const load = (locale: string) =>
  JSON.parse(readFileSync(`messages/${locale}.json`, 'utf8')) as Catalogue;

/** Every leaf path, so a nested section cannot drift unnoticed. */
function paths(obj: unknown, prefix = ''): string[] {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return [prefix];

  return Object.entries(obj as Catalogue).flatMap(([k, v]) =>
    paths(v, prefix ? `${prefix}.${k}` : k),
  );
}

describe('message catalogue parity', () => {
  const bg = load('bg');
  const en = load('en');

  it('both catalogues actually loaded', () => {
    // A parse returning {} would make every assertion below vacuous.
    expect(paths(bg).length).toBeGreaterThan(5);
    expect(paths(en).length).toBeGreaterThan(5);
  });

  it('bg and en have IDENTICAL key sets', () => {
    const inBg = new Set(paths(bg));
    const inEn = new Set(paths(en));

    const missingFromBg = [...inEn].filter((k) => !inBg.has(k)).sort();
    const missingFromEn = [...inBg].filter((k) => !inEn.has(k)).sort();

    if (missingFromBg.length || missingFromEn.length) {
      throw new Error(
        `The message catalogues have drifted.\n\n` +
          (missingFromBg.length
            ? `  MISSING FROM bg.json (a Bulgarian user sees English or a raw key):\n` +
              missingFromBg.map((k) => `    ${k}`).join('\n') +
              '\n'
            : '') +
          (missingFromEn.length
            ? `  MISSING FROM en.json:\n` + missingFromEn.map((k) => `    ${k}`).join('\n') + '\n'
            : ''),
      );
    }

    expect(missingFromBg).toEqual([]);
    expect(missingFromEn).toEqual([]);
  });

  it('no bg string is just the English echoed back', () => {
    // The laziest way to satisfy the check above is to paste the English in.
    // That passes parity and still shows English to a Bulgarian user.
    //
    // Two things are legitimately identical across locales and must not fail:
    //
    //   - single terms that are the same word in both — "Google", "Padel";
    //   - pure ICU TEMPLATES. `'{verb} {count} {noun}?'` carries no prose at
    //     all, so it is correctly byte-identical in bg and en. This check
    //     flagged exactly that on its first run, which is why placeholders are
    //     stripped before judging rather than after.
    //
    // What remains is a value identical to its English counterpart that still
    // contains real words once the placeholders are removed.
    const bgPaths = paths(bg);
    const get = (o: Catalogue, p: string) =>
      p.split('.').reduce<unknown>((acc, k) => (acc as Catalogue)?.[k], o);

    const prose = (v: string) => v.replace(/\{[^}]*\}/g, '').trim();

    const echoed = bgPaths.filter((p) => {
      const b = get(bg, p);
      const e = get(en, p);
      if (typeof b !== 'string' || b !== e) return false;

      const words = prose(b);
      // A phrase, not a term: contains a space and at least one letter.
      return words.includes(' ') && /\p{L}/u.test(words);
    });

    expect(echoed).toEqual([]);
  });
});
