/**
 * A desk customer's phone number, in one canonical form (#364).
 *
 * The desk types what the customer says: "0888 123 456", "+359 88 812 3456",
 * "00359888123456". Stored as typed, the same person would be three customers,
 * and "match by phone" would find none of the others. So every number is
 * written, and compared, as E.164: `+` and digits only.
 *
 * Bulgarian-first, because the pilot is in Sofia: a national number (one
 * leading 0) becomes +359 without its 0. A number already international
 * (`+…` or `00…`) is kept as it is, so a tourist's +44 stays British.
 *
 * Returns null for anything that is not a plausible number after that: fewer
 * than 8 or more than 15 digits (E.164's ceiling), or letters. The caller
 * decides what null means — a 400 on a write, "no match" on a lookup.
 */
export function normalizePhone(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;

  // Spaces, dashes, dots, slashes and brackets are how people group digits.
  // Anything else (a letter, an extension marker) is not a phone number.
  const compact = trimmed.replace(/[\s\-./()]/g, '');
  if (!/^\+?\d+$/.test(compact)) return null;

  let e164: string;
  if (compact.startsWith('+')) e164 = compact;
  else if (compact.startsWith('00')) e164 = `+${compact.slice(2)}`;
  else if (compact.startsWith('0')) e164 = `+359${compact.slice(1)}`;
  // Bare digits with no prefix: a Bulgarian number typed with its country
  // code and no plus ("359888…"), or a local one missing its 0. The first is
  // common enough to accept; the second is a guess, and refused.
  else if (compact.startsWith('359')) e164 = `+${compact}`;
  else return null;

  const digits = e164.length - 1;
  if (digits < 8 || digits > 15) return null;
  return e164;
}
