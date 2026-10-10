import type { InboxSide } from '@/lib/data/keys';

/**
 * Where an inbox and its conversations live in the app (#375): the player's
 * own under /messages, a club's under its admin. One place, so a link from the
 * bell, an inbox row and a "Пиши" button can never disagree.
 */
export function inboxPath(side: InboxSide): string {
  return side.kind === 'club' ? `/t/${side.slug}/admin/messages` : '/messages';
}

export function conversationPath(side: InboxSide, id: string): string {
  return `${inboxPath(side)}/${id}`;
}
