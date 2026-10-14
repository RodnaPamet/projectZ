import { nounsOf, type ResourceNoun, type ResourceNouns } from './resource-kinds';

/**
 * A LIST OF NOUNS IN A SENTENCE (#477).
 *
 * A message that can name several kinds of resource ("Кортове, маси и
 * места") has one wording for all of them, under `several.`, with one slot
 * for the list. The slot's name says which form of the list it wants, and
 * the same name is used in both languages (the i18n guardrail holds every
 * message to the same placeholders in each):
 *
 *   {Nouns}         plural, "and", capitalised    "Кортове, маси и места"
 *   {nouns}         plural, "and"                 "кортове, маси и места"
 *   {AnyNoun}       singular, "or", capitalised   "Корт, маса или място"
 *   {anyNoun}       singular, "or"                "корт, маса или място"
 *   {countedNouns}  after a number, "and"         "корта, маси и места"
 *   {NounSlash}     singular, " / ", capitalised  "Корт / маса / място"
 *
 * Each noun's forms are copy, in `nouns.<noun>.*` (`one`, `many`,
 * `counted`); the joining is the language's own (`Intl.ListFormat`).
 */

/** The forms a noun has in `nouns.<noun>`. */
export type NounForm = 'one' | 'many' | 'counted';

export interface NounListValues {
  Nouns: string;
  nouns: string;
  AnyNoun: string;
  anyNoun: string;
  countedNouns: string;
  NounSlash: string;
}

type Words = (key: string) => string;
type Translate = (key: string, values?: Record<string, string | number>) => string;
/**
 * Any next-intl translator: its key parameter is a union of the namespace's
 * keys, which `never` accepts, so a typed `t` passes here as it is.
 */
type AnyT = (key: never, values?: never) => string;

const capital = (text: string, locale: string) =>
  text.charAt(0).toLocaleUpperCase(locale) + text.slice(1);

/** Every form of the list `nouns`, for a `several.` message to pick from. */
export function nounListValues(
  tNouns: AnyT,
  locale: string,
  nouns: readonly ResourceNoun[],
): NounListValues {
  const tag = locale === 'en' ? 'en-GB' : locale;
  const and = new Intl.ListFormat(tag, { type: 'conjunction' });
  const or = new Intl.ListFormat(tag, { type: 'disjunction' });
  // `t` is bound to `nouns`; the key is built from data, so it is named here.
  const t = tNouns as unknown as Words;
  const word = (noun: ResourceNoun, form: NounForm) => {
    const key = `${noun}.${form}`;
    return t(key);
  };
  const many = and.format(nouns.map((n) => word(n, 'many')));
  const any = or.format(nouns.map((n) => word(n, 'one')));
  return {
    Nouns: capital(many, locale),
    nouns: many,
    AnyNoun: capital(any, locale),
    anyNoun: any,
    // Bulgarian counts a masculine noun in its own form ("3 корта"); the
    // ones after it read as plurals of the same number.
    countedNouns: and.format(nouns.map((n, i) => word(n, i === 0 ? 'counted' : 'many'))),
    NounSlash: capital(nouns.map((n) => word(n, 'one')).join(' / '), locale),
  };
}

/**
 * A message about the resources a list holds: for one noun, that noun's own
 * wording (`key` for the court, `<noun>.key` for any other); for several,
 * `several.key`, its slot filled.
 */
export function nounMessage(
  t: AnyT,
  tNouns: AnyT,
  locale: string,
  list: ResourceNouns,
  key: string,
  values: Record<string, string | number> = {},
): string {
  const say = t as unknown as Translate;
  const held = nounsOf(list);
  if (held.length === 1) return say(held[0] === 'court' ? key : `${held[0]}.${key}`, values);
  return say(`several.${key}`, { ...values, ...nounListValues(tNouns, locale, held) });
}
