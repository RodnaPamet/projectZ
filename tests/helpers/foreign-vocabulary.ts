/**
 * Words that belong to inflect-compliance, not to a court-booking app, in both catalogues.
 *
 * playerz vendors inflect's UI and none of its vocabulary: the owner's rule is
 * "only the UI, not the pages or vocabulary". A label that reads "Risks" or
 * "Доказателства" in playerz's chrome means somebody copied inflect's content
 * along with its components. `scripts/ui-sync/portable-rules.mjs` keeps these
 * words out of vendored SOURCE; this list is for rendered COPY, so a test can
 * assert a surface shows none of them in either language.
 *
 * Whole words, case-insensitive. Kept short and certain: every entry is a
 * compliance noun with no ordinary meaning in a sports product. "Audit log"
 * and "platform audit" are real playerz features (#263's audit trail), so
 * "audit" is NOT here.
 *
 * T29 adds the lists below for tests/guardrails/foreign-vocabulary.test.ts,
 * which reads the playerz-owned SOURCE (code, catalogues, route segments,
 * exported names) rather than one rendered surface.
 */
export const FOREIGN_VOCABULARY = {
  en: [
    'Controls',
    'Risks',
    'Evidence',
    'Policies',
    'Vendors',
    'Frameworks',
    'Findings',
    'Assessments',
    'Requirements',
    'Incidents',
    'Assets',
    'Compliance',
    'Posture',
    'Readiness',
    'Remediation',
  ],
  bg: [
    'Контроли',
    'Рискове',
    'Доказателства',
    'Политики',
    'Доставчици',
    'Рамки',
    'Констатации',
    'Оценки',
    'Изисквания',
    'Инциденти',
    'Активи',
    'Съответствие',
    'Готовност',
  ],
} as const satisfies Record<'en' | 'bg', readonly string[]>;

/** The foreign words `text` contains, as whole words, ignoring case. */
export function foreignWordsIn(text: string, locale: 'en' | 'bg'): string[] {
  return FOREIGN_VOCABULARY[locale].filter((word) =>
    new RegExp(`(?<![\\p{L}\\p{N}_])${word}(?![\\p{L}\\p{N}_])`, 'iu').test(text),
  );
}

// ─── The source-level lists (T29) ────────────────────────────────────────

/**
 * The upstream product and the three brands its fixtures and marks carried.
 * Banned in playerz-owned strings AND comments: a comment that says where a
 * file came from says "upstream" (docs/ui-sync/README.md defines it), so the
 * brand never has to be spelled out in this tree. Links to the upstream repo
 * are not prose and are blanked first (see TECHNICAL).
 */
export const BRANDS = ['Inflect', 'PwC', 'METRO', 'Dub'] as const;

/**
 * Compliance-product nouns, banned in playerz-owned COPY: string literals and
 * JSX text in src/, both catalogues' keys and values, route segments and
 * exported identifiers. Regex sources, whole words or phrases, case-insensitive.
 *
 * `control`, `risk`, `policy`, `vendor`, `framework` and `audit` alone are NOT
 * here: "form control", "at your own risk", "privacy policy", "payment
 * vendor", "the test framework" and the audit log are all ordinary playerz.
 * The compound forms that only a compliance product says are.
 */
export const COMPLIANCE_TERMS = {
  en: [
    'compliance',
    'GRC',
    'evidence',
    'auditors?',
    'SoA',
    'ISO[\\s/-]*(?:IEC[\\s/-]*)?27001',
    'ISMS',
    'SOX',
    'NIS\\s?2',
    'attestations?',
    'remediations?',
    'posture',
    'risk[\\s-]registers?',
    'risk[\\s-]scores?',
    'risk[\\s-]matri(?:x|ces)',
    '(?:inherent|residual)[\\s-]risks?',
    'security[\\s-]controls?',
    'control[\\s-]coverage',
    'findings?',
    'assessments?',
  ],
  bg: [
    'доказателств\\p{L}*',
    'одитор\\p{L}*',
    'вътрешен\\s+одит',
    'констатаци\\p{L}*',
    'регистър\\s+на\\s+рисковете',
    'оценка\\s+на\\s+риска',
    'управление\\s+на\\s+съответствието',
  ],
} as const;

/**
 * Words that are a compliance product's SECTION NAMES but ordinary words
 * otherwise. Banned only where a section is named: a route segment, a
 * catalogue key segment, or a catalogue value that is nothing but the word
 * (a nav label). "Frameworks" as a heading is inflect; "the framework" in a
 * sentence is not.
 */
export const SECTION_NAMES = ['frameworks?', 'vendors?', 'controls?', 'контроли'] as const;

/**
 * In COMMENTS only the unambiguous terms. playerz's own comments say
 * "WHERE clause", "readiness probe" (/api/ready), "finding" (of a review),
 * "framework" and "vendored", and they are right to.
 */
export const COMMENT_TERMS = [
  'ISO[\\s/-]*(?:IEC[\\s/-]*)?27001',
  'ISMS',
  'SoA',
  'NIS\\s?2',
  'SOX',
  'GRC',
  'risk[\\s-]registers?',
  'risk[\\s-]matri(?:x|ces)',
  '(?:inherent|residual)[\\s-]risks?',
  'control[\\s-]coverage',
  'audit[\\s-]cycles?',
  ...BRANDS,
] as const;

const wordRe = (terms: readonly string[]) =>
  new RegExp(`(?<![\\p{L}\\p{N}_])(?:${terms.join('|')})(?![\\p{L}\\p{N}_])`, 'giu');

export const COPY_RE = wordRe([...COMPLIANCE_TERMS.en, ...COMPLIANCE_TERMS.bg, ...BRANDS]);
export const COMMENT_RE = wordRe(COMMENT_TERMS);
export const SECTION_RE = new RegExp(`^(?:${SECTION_NAMES.join('|')})$`, 'iu');

/**
 * Not prose: blanked (length kept) before matching. A link to the upstream
 * repo or one of its issues, and ARIA's own `aria-controls`.
 */
const TECHNICAL = /https?:\/\/\S+|aria-controls/giu;
export const blankTechnical = (text: string) =>
  text.replace(TECHNICAL, (m) => ' '.repeat(m.length));

/** Every match of `re` in `text`, technical spans blanked first. */
export function termsIn(text: string, re: RegExp): Array<{ index: number; term: string }> {
  return [...blankTechnical(text).matchAll(re)].map((m) => ({ index: m.index, term: m[0] }));
}

/**
 * An identifier as the words it spells: `recordAiRiskAssessment` →
 * "record Ai Risk Assessment", `RISK_SCORE` → "RISK SCORE", so the copy list
 * reads names the same way it reads sentences.
 */
export function identifierWords(id: string): string {
  return id
    .replace(/([a-z\d])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/[_$-]+/g, ' ')
    .trim();
}
