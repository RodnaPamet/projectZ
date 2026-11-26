/**
 * Why a review was refused, in words the author can read (#714).
 *
 * The EU Digital Services Act (Art. 17) wants a statement of reasons whenever
 * we refuse or remove a review: what was done, on which rule, whether it was
 * decided automatically, and how to challenge it. The terms of use promise the
 * same (section 10, «Мотиви»).
 *
 * A reason is one of the codes below. Never the classifier's output as such:
 * its scores are for the moderator, and an author handed them has a gauge for
 * tuning text until it slips through. The classifier's CATEGORY maps onto a
 * code; a moderator picks one (from the same list) when they refuse.
 *
 * The codes follow the rules the author agreed to: the classifier's
 * categories, plus the rules of section 9 of the terms that a classifier
 * cannot judge (personal data, pretending to be someone, false reviews).
 * `other` is the terms in general, for a case that fits none of them.
 */

export const REFUSAL_REASONS = [
  'harassment',
  'hate',
  'sexual',
  'sexual_minors',
  'violence',
  'self_harm',
  'self_harm_instructions',
  'spam',
  'personal_data',
  'impersonation',
  'false_review',
  'other',
] as const;

export type RefusalReason = (typeof REFUSAL_REASONS)[number];

export function isRefusalReason(v: unknown): v is RefusalReason {
  return typeof v === 'string' && (REFUSAL_REASONS as readonly string[]).includes(v);
}

/**
 * The reason for a classifier category or a case's `reason`
 * (`sexual/minors` → `sexual_minors`). Anything that is not a category
 * (`user_report`, `classifier_unavailable`, `unknown`, null) is `other`.
 */
export function refusalReasonFor(caseReason: string | null | undefined): RefusalReason {
  const code = (caseReason ?? '').replace(/[/-]/g, '_');
  return isRefusalReason(code) ? code : 'other';
}

/** What happened to the review. */
export type RefusalAction = 'NOT_PUBLISHED' | 'REMOVED';

/** The statement of reasons as the author's own reads carry it (v1 `ReviewRefusal`). */
export interface ReviewRefusal {
  action: RefusalAction;
  reason: RefusalReason;
  /** True: decided by the AI check; false: by a moderator. */
  automated: boolean;
  decidedAt: Date;
}

/** The four `refusal*` columns of `review` / `coach_review`. */
export interface RefusalColumns {
  refusalReason: string | null;
  refusalAutomated: boolean | null;
  refusalRemoved: boolean | null;
  refusedAt: Date | null;
}

/** The refusal stored on a review row; null when it was not refused. */
export function refusalOf(row: { status: string } & RefusalColumns): ReviewRefusal | null {
  if (row.status !== 'REJECTED' || !row.refusedAt) return null;
  return {
    action: row.refusalRemoved ? 'REMOVED' : 'NOT_PUBLISHED',
    reason: refusalReasonFor(row.refusalReason),
    automated: row.refusalAutomated ?? false,
    decidedAt: row.refusedAt,
  };
}

/** The columns' select, for every read that returns `refusal`. */
export const REFUSAL_SELECT = {
  refusalReason: true,
  refusalAutomated: true,
  refusalRemoved: true,
  refusedAt: true,
} as const;

/** The columns cleared, when a moderator publishes a review. */
export const NO_REFUSAL: RefusalColumns = {
  refusalReason: null,
  refusalAutomated: null,
  refusalRemoved: null,
  refusedAt: null,
};

/** Where an author objects (terms, section 10). */
export const OBJECTION_ADDRESS = 'privacy@playerz.bg';
