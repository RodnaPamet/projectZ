/**
 * The word a person types to confirm deleting their account (#370).
 *
 * Both languages' words are accepted whatever the page's language, because a
 * Bulgarian reader is often on a Latin keyboard (and an English one may copy
 * the Bulgarian word off a friend's screen). Case and the spaces around it do
 * not matter. The words are the catalogue's `profile.delete.dialog.word` in
 * each language, lower-cased; tests/unit/account/confirm-word.test.ts holds the
 * two lists to each other.
 */
export const DELETE_CONFIRM_WORDS: readonly string[] = ['изтрий', 'delete'];

export function confirmsDeletion(typed: string): boolean {
  const word = typed.normalize('NFC').trim().replace(/\s+/g, ' ').toLocaleLowerCase();
  return DELETE_CONFIRM_WORDS.includes(word);
}
