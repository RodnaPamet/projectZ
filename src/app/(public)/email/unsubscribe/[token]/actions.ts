'use server';

import { revalidatePath } from 'next/cache';

import { unsubscribeByToken } from '@/app-layer/usecases/email-unsubscribe';
import { unsubscribePagePath } from '@/lib/email/unsubscribe';
import { RateLimitedError } from '@/lib/errors/types';

/**
 * The page's one button (#528). The token is the authority: it was signed for
 * one account and one kind of email, and this switches that kind off. No
 * session is read, because the person may well be signed out.
 *
 * Open to anyone, so what stands in for authentication is `unsubscribeByToken`:
 * it refuses a link this server did not sign before it costs a query, and
 * limits the one write it can be made to do, per account.
 */
export async function stopEmailsAction(token: string): Promise<void> {
  try {
    const done = await unsubscribeByToken(token);
    if (done) revalidatePath(unsubscribePagePath(token));
  } catch (err) {
    // Past the limit the kind is off already (the first press did it): the
    // page just shows where things stand.
    if (!(err instanceof RateLimitedError)) throw err;
  }
}
