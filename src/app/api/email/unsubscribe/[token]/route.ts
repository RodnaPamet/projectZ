import { type NextRequest, NextResponse } from 'next/server';

import { unsubscribeByToken } from '@/app-layer/usecases/email-unsubscribe';
import { unsubscribePagePath } from '@/lib/email/unsubscribe';
import { RateLimitedError } from '@/lib/errors/types';
import { absoluteUrl } from '@/lib/seo/site-url';

/**
 * The one-click unsubscribe of RFC 8058 (#528): where a mail client's own
 * "unsubscribe" button POSTs.
 *
 * Every email a person can switch off carries
 *
 *   List-Unsubscribe: <https://playerz.bg/api/email/unsubscribe/{token}>
 *   List-Unsubscribe-Post: List-Unsubscribe=One-Click
 *
 * and Gmail, Apple Mail and the rest then POST here, from their own servers,
 * with no cookies and `List-Unsubscribe=One-Click` as the body. So there is no
 * session to read and no origin to check: the token is the authority, and all
 * it can do is switch one kind of email off for the account it was signed for.
 *
 * POST  200 `{ "unsubscribed": true }`, also when it already was.
 *       404 for a link this server did not sign. One answer for every such
 *       link, and none that says whether an account exists.
 *       429 past 30 a minute for one account (the use case's limit).
 * GET   a person who opens the header's link in a browser is sent to the page
 *       that asks first (`/email/unsubscribe/{token}`). A GET never switches
 *       anything off: scanners and previews open every link in an email.
 *
 * Not under `/api/v1`: it is not part of the app's API, a mail client calls
 * it, and its address is in every email already sent.
 */

const notOurs = () =>
  NextResponse.json(
    { error: { code: 'NOT_FOUND', message: 'This unsubscribe link is not valid.' } },
    { status: 404 },
  );

export async function POST(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;

  try {
    const done = await unsubscribeByToken(decodeURIComponent(token));
    if (!done) return notOurs();
  } catch (err) {
    if (!(err instanceof RateLimitedError)) throw err;
    return NextResponse.json(
      { error: { code: 'RATE_LIMITED', message: 'Too many requests. Try again in a minute.' } },
      { status: 429 },
    );
  }
  return NextResponse.json({ unsubscribed: true });
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  // On the PUBLIC origin (SITE_URL), never on `req.url`: behind the reverse
  // proxy a route handler's own URL is the container's (`localhost:3000`), and
  // a redirect built on it sent the browser there. Found on staging.
  return NextResponse.redirect(absoluteUrl(unsubscribePagePath(token)), 303);
}
