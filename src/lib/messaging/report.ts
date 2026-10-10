/**
 * Why a message or a conversation is reported (#375). The moderator sees the
 * category and, when given, the reporter's own words; never who reported.
 * A module of its own, with no imports, so the screens read it too.
 */
export const REPORT_REASONS = ['spam', 'abuse', 'inappropriate', 'other'] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];

/** At most this much of the reporter's own words reaches the moderator. */
export const REPORT_DETAILS_MAX = 500;
