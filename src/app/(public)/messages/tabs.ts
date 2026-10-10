/** The inbox's two tabs (#375): every conversation, and «Заявки». */
export const INBOX_TABS = ['conversations', 'requests'] as const;
export type InboxTab = (typeof INBOX_TABS)[number];

/** `?tab=` as the page reads it: anything but `requests` is the conversations. */
export function inboxTabFrom(raw: string | string[] | undefined): InboxTab {
  const v = Array.isArray(raw) ? raw[0] : raw;
  return v === 'requests' ? 'requests' : 'conversations';
}
