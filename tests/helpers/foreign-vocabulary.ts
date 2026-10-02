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
 * "audit" is NOT here. T29 extends the list as more surfaces adopt the shell.
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
