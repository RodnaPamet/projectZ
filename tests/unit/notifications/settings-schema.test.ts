/** @jest-environment node */

import { notificationSettingsPatchSchema } from '@/app-layer/schemas/notifications';

/**
 * «Факт на деня» (P88) is a push switch only: the fact is never emailed, so
 * an email switch for it is refused by name rather than accepted and ignored.
 */
describe('PATCH /me/notification-settings body', () => {
  it('takes sportFacts under push', () => {
    expect(notificationSettingsPatchSchema.parse({ push: { sportFacts: false } })).toEqual({
      push: { sportFacts: false },
    });
  });

  it('refuses sportFacts under email', () => {
    expect(
      notificationSettingsPatchSchema.safeParse({ email: { sportFacts: false } }).success,
    ).toBe(false);
  });

  it('still takes the shared kinds on both', () => {
    expect(
      notificationSettingsPatchSchema.safeParse({
        email: { reminder: false },
        push: { lessonsTaught: false },
      }).success,
    ).toBe(true);
  });
});
