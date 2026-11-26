import { CATEGORIES } from '@/lib/moderation/classify';
import {
  isRefusalReason,
  REFUSAL_REASONS,
  refusalOf,
  refusalReasonFor,
} from '@/lib/moderation/refusal';
import bg from '../../../messages/bg.json';
import en from '../../../messages/en.json';

/**
 * The reasons a refused review is explained with (#714, DSA Art. 17): a rule
 * in plain words, never the classifier's output.
 */

describe('every classifier category maps to a reason of its own', () => {
  it.each(CATEGORIES.map((c) => [c]))('%s', (category) => {
    const reason = refusalReasonFor(category);
    expect(reason).not.toBe('other');
    expect(isRefusalReason(reason)).toBe(true);
  });

  it('the two automatic ones, by the names the privacy policy uses', () => {
    expect(refusalReasonFor('sexual/minors')).toBe('sexual_minors');
    expect(refusalReasonFor('self-harm/instructions')).toBe('self_harm_instructions');
    expect(bg.myBookings.review.refusal.reason.sexual_minors).toBe(
      'сексуално съдържание с участие на деца',
    );
    expect(bg.myBookings.review.refusal.reason.self_harm_instructions).toBe(
      'указания за самонараняване',
    );
  });

  it('a case that is not about a category is the terms in general', () => {
    for (const r of ['user_report', 'classifier_unavailable', 'unknown', '', null, undefined]) {
      expect(refusalReasonFor(r)).toBe('other');
    }
  });

  it('a code is already a reason', () => {
    expect(refusalReasonFor('personal_data')).toBe('personal_data');
  });
});

describe('every reason has words, in both languages, for the author and the moderator', () => {
  it.each(REFUSAL_REASONS.map((r) => [r]))('%s', (reason) => {
    for (const m of [bg, en]) {
      expect(m.myBookings.review.refusal.reason[reason]).toBeTruthy();
      expect(m.platform.moderation.rule.option[reason]).toBe(
        m.myBookings.review.refusal.reason[reason],
      );
    }
    // No Russianisms in what the author reads.
    expect(bg.myBookings.review.refusal.reason[reason]).not.toMatch(/[ыэё]|ь(?!о)/);
  });
});

describe('the stored refusal', () => {
  const at = new Date('2026-11-26T10:00:00Z');
  const row = {
    status: 'REJECTED',
    refusalReason: 'harassment',
    refusalAutomated: false,
    refusalRemoved: true,
    refusedAt: at,
  };

  it('reads back what was decided', () => {
    expect(refusalOf(row)).toEqual({
      action: 'REMOVED',
      reason: 'harassment',
      automated: false,
      decidedAt: at,
    });
    expect(refusalOf({ ...row, refusalRemoved: false, refusalAutomated: true })).toMatchObject({
      action: 'NOT_PUBLISHED',
      automated: true,
    });
  });

  it('is null for a review that is not refused, or was refused before P91', () => {
    expect(refusalOf({ ...row, status: 'PUBLISHED' })).toBeNull();
    expect(refusalOf({ ...row, status: 'PENDING_REVIEW' })).toBeNull();
    expect(refusalOf({ ...row, refusedAt: null })).toBeNull();
  });

  it('an unknown stored code reads as the terms in general', () => {
    expect(refusalOf({ ...row, refusalReason: 'something-new' })?.reason).toBe('other');
  });
});
