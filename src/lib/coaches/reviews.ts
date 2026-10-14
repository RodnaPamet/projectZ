/**
 * Coach reviews (#551), the parts the screens share with the server. A module
 * with no imports, so a client component can read it.
 */

/** A review's text, at most (P74's check says the same). */
export const COACH_REVIEW_MAX_LENGTH = 1000;

/** «Петя И.»: the first name and the initial of the last (decision 26). Null for no name. */
export function shortName(name: string | null | undefined): string | null {
  const parts = (name ?? '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return null;
  const [first, ...rest] = parts;
  const last = rest.at(-1);
  return last ? `${first} ${Array.from(last)[0]!.toLocaleUpperCase('bg')}.` : first!;
}
