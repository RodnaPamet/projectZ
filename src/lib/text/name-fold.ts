/**
 * A NAME IN ONE FORM, WHICHEVER ALPHABET IT WAS TYPED IN (#482).
 *
 * Lower-case Latin, by the Bulgarian streamlined transliteration ("Петър" →
 * "petar", "Щерев" → "sherev" is "shterev"), with the Russian letters a Sofia
 * player may type (ё, ы, э). Latin is only lower-cased. So "Ivan" finds
 * «Иван», and «иван» finds "Ivan".
 *
 * The SAME mapping as the database's `playerz_name_fold` (P75), which the
 * player search's index is built on: the query is folded here and compared
 * with the folded name there. tests/integration/player-name-search.test.ts
 * checks the two agree, name by name.
 */

const UPPER = 'АБВГДЕЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЬЮЯЁЫЭЍ';
const LOWER = 'абвгдежзийклмнопрстуфхцчшщъьюяёыэѝ';
/** Letters that become more than one: replaced first, in this order. */
const PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['щ', 'sht'],
  ['ж', 'zh'],
  ['ч', 'ch'],
  ['ш', 'sh'],
  ['ц', 'ts'],
  ['ю', 'yu'],
  ['я', 'ya'],
  ['х', 'h'],
  ['ё', 'yo'],
];
const FROM = 'абвгдезийклмнопрстуфъьыэѝ';
const TO = 'abvgdeziyklmnoprstufayyei';

/** PostgreSQL's `translate`: each char of `from` becomes the one at its index in `to`. */
function translate(text: string, from: string, to: string): string {
  const map = new Map(Array.from(from).map((c, i) => [c, Array.from(to)[i] ?? '']));
  return Array.from(text, (c) => map.get(c) ?? c).join('');
}

export function foldName(input: string): string {
  let text = translate(input.toLowerCase(), UPPER, LOWER);
  for (const [from, to] of PAIRS) text = text.split(from).join(to);
  return translate(text, FROM, TO);
}
