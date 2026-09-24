import { readFileSync } from 'node:fs';

/**
 * THE BULGARIAN CATALOGUE MUST BE IN CYRILLIC.
 *
 * Ported from agri-saas. The parity guard next door catches MISSING keys; it
 * cannot catch a key that is present and still English, because "present" is
 * all a keyset comparison knows about.
 *
 * Comparing the two catalogues byte-for-byte does not close it either: it
 * flags `"Save"` only while the English value happens to be identical, and
 * has to skip short single-word labels to avoid firing on brands and
 * acronyms — which is exactly the class of untranslated label a user notices
 * first.
 *
 * So this uses a SCRIPT signal instead of a copy signal. Bulgarian is written
 * in Cyrillic. A `bg.json` value with NO Cyrillic character in it at all,
 * after ICU scaffolding and placeholders are stripped, is untranslated —
 * whatever the English value happens to say.
 *
 * ═══ DELIBERATELY NARROW, SO IT STAYS AT ZERO FALSE POSITIVES ═══
 *
 * Only values with no Cyrillic WHATSOEVER are flagged. A Bulgarian sentence
 * embedding a proper noun or a unit — "напр. Wilson Pro Staff", "PDF, CSV" —
 * is mixed prose, which is real translation, and is not flagged. What this
 * catches is the pure-Latin leaf: "Save", "No venues match your search",
 * "In Progress".
 *
 * Values that are legitimately Latin are excluded either by construction (a
 * token allow-set of brands, acronyms, units, URLs) or by key in
 * LATIN_ALLOWLIST with a reason. Adding a key there asserts "this Bulgarian
 * value really is Latin on purpose".
 */

const BG = 'messages/bg.json';

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
 * Strip ICU scaffolding, leaving only human copy.
 *
 * `plural`, `select`, `one`, `other` and the argument names are Latin SYNTAX,
 * not text anybody reads. Counting them as English would flag every correctly
 * translated plural in the file.
 */
function stripIcu(s: string): string {
  return s
    .replace(/\{\s*[a-zA-Z0-9_]+\s*,\s*(?:plural|select|selectordinal)\s*,/g, ' ')
    .replace(/\b(?:zero|one|two|few|many|other)\s*\{/g, '{')
    .replace(/=\d+\s*\{/g, '{')
    .replace(/\{[a-zA-Z0-9_]+\}/g, ' ')
    .replace(/[{}#]/g, ' ');
}

const CYRILLIC = /[Ѐ-ӿ]/;

/** Latin tokens that are not English COPY: brands, acronyms, units, codes. */
const NON_COPY_TOKEN =
  /^(playerz|playerz\.bg|Stripe|Apple|Google|Strava|Centrifugo|Meilisearch|Prometheus|PWA|APNs|API|URL|URI|HTTPS?|PDF|CSV|JSON|ICS|SMS|OTP|MFA|TOTP|SSO|OAuth|SAML|GDPR|ISO|UUID|ID|IP|QR|VAT|BGN|EUR|USD|EU|BG|km|m|h|min|GPS|iOS|Android|v\d[\d.]*)$/i;

function isCodeLike(value: string): boolean {
  return /@|https?:\/\/|\b[\w-]+\.(bg|com|io|app|org|net|eu)\b/.test(value);
}

/** bg values that are Latin ON PURPOSE. Each needs a reason. */
const LATIN_ALLOWLIST = new Map<string, string>([
  ['common.appName', 'the product name — a brand, identical in both languages'],
]);

const entries = [...flatten(JSON.parse(readFileSync(BG, 'utf8')))].filter(
  (e): e is [string, string] => typeof e[1] === 'string',
);

describe('the Bulgarian catalogue is in Bulgarian', () => {
  it('read the catalogue', () => {
    // A parse that yielded nothing would make the assertion below vacuous.
    expect(entries.length).toBeGreaterThan(50);
  });

  it('no value is pure Latin', () => {
    const untranslated = entries
      .filter(([key]) => !LATIN_ALLOWLIST.has(key))
      .filter(([, value]) => {
        const copy = stripIcu(value).trim();
        if (!copy) return false;
        if (CYRILLIC.test(copy)) return false;
        if (isCodeLike(copy)) return false;
        // A value made only of brands, acronyms and punctuation is not English.
        const words = copy.split(/[\s,./|—–-]+/).filter(Boolean);
        return !words.every((w) => NON_COPY_TOKEN.test(w) || !/[a-zA-Z]/.test(w));
      });

    if (untranslated.length > 0) {
      throw new Error(
        `${untranslated.length} Bulgarian value(s) contain no Cyrillic at all:\n\n` +
          untranslated.map(([k, v]) => `  ${k}\n    "${v}"`).join('\n') +
          `\n\nBulgarian is written in Cyrillic, so a pure-Latin value is English\n` +
          `that was never translated — the kind a user notices first.\n\n` +
          `Translate it, or add the key to LATIN_ALLOWLIST with the reason it is\n` +
          `genuinely Latin (a brand, a unit, a code sample).`,
      );
    }
  });

  it('every allowlist entry still exists and still has a reason', () => {
    // An allowlist entry for a deleted key is a hole waiting for somebody to
    // recreate that key, and it would never fail on its own.
    const keys = new Set(entries.map(([k]) => k));
    expect([...LATIN_ALLOWLIST.keys()].filter((k) => !keys.has(k))).toEqual([]);
    expect([...LATIN_ALLOWLIST.values()].filter((r) => r.trim().length < 10)).toEqual([]);
  });
});
