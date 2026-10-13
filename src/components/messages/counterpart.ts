import type { ConversationSummaryDto } from '@/app/api/v1/_lib/messaging';

type Counterpart = ConversationSummaryDto['counterpart'];

/**
 * What a conversation is called (#375, #376): the club's name, the other
 * player's (or «Изтрит потребител»), or for a game chat «Игра в {venue}». The
 * words come from the caller, which asks its catalogue for them by name.
 */
export function counterpartName(
  c: Counterpart,
  words: { unnamed: string; deletedUser: string; game: (venue: string) => string },
): string {
  if (c.kind === 'club') return c.name;
  if (c.kind === 'game') return words.game(c.venueName);
  return c.deleted ? words.deletedUser : (c.name ?? words.unnamed);
}

/** A player's picture; a club and a game chat show initials. */
export function counterpartAvatar(c: Counterpart): string | null {
  return c.kind === 'player' ? c.avatarUrl : null;
}
