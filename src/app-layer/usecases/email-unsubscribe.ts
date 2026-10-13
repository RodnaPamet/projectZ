import {
  getMyNotificationSettings,
  updateMyNotificationSettings,
} from '@/app-layer/usecases/my-notifications';
import { readUnsubscribeToken, type UnsubscribeCategory } from '@/lib/email/unsubscribe';
import { RateLimitedError } from '@/lib/errors/types';
import { checkRateLimit, type RateLimitConfig } from '@/lib/security/rate-limit';
import { isRateLimitBypassed } from '@/lib/security/rate-limit-middleware';

/**
 * What an unsubscribe link does (#528): one kind of email, off, for the
 * account the link was signed for. See src/lib/email/unsubscribe.ts for what
 * the link is.
 *
 * Both run as the account itself (`runAsUserOnly`, inside the settings use
 * case): the token names the account, and the write is the same one its
 * owner makes in Профил → Известия.
 *
 * A link for an account that has since been deleted answers as done: there is
 * nothing left to email, and saying "no such account" would tell whoever
 * holds an old email that the account is gone.
 */

/** What the page shows before anything is pressed: which kind, and is it still on. */
export async function unsubscribeStanding(
  token: unknown,
): Promise<{ category: UnsubscribeCategory; on: boolean } | null> {
  const t = readUnsubscribeToken(token);
  if (!t) return null;
  const settings = await getMyNotificationSettings(t.userId);
  return { category: t.category, on: settings?.email[t.category] ?? false };
}

/**
 * Generous for a person and their mail client, small for anybody replaying a
 * link. Per ACCOUNT, not per address: a link that is not ours is refused
 * before it costs a query, so the only work an open endpoint can be made to
 * do is this one write, and this is what bounds it.
 */
export const UNSUBSCRIBE_LIMIT: RateLimitConfig = { maxAttempts: 30, windowMs: 60_000 };

/**
 * Switch that kind off. Pressing twice is pressing once. Null: not our link.
 * Throws `RateLimitedError` past the limit above.
 */
export async function unsubscribeByToken(
  token: unknown,
): Promise<{ category: UnsubscribeCategory } | null> {
  const t = readUnsubscribeToken(token);
  if (!t) return null;
  if (!isRateLimitBypassed()) {
    const limit = await checkRateLimit(`email-unsubscribe:u:${t.userId}`, UNSUBSCRIBE_LIMIT);
    if (!limit.allowed) throw new RateLimitedError('Too many requests. Try again in a minute.');
  }
  await updateMyNotificationSettings(t.userId, { [t.category]: false });
  return { category: t.category };
}
