import type { NextRequest, NextResponse } from 'next/server';

/**
 * next-auth's session cookie, and the chunks a large token is split into:
 * `next-auth.session-token`, `__Secure-next-auth.session-token`, and either
 * with `.0`, `.1`, … (next-auth 4.24 `SessionStore.chunk`).
 */
const SESSION_COOKIE = /^(__Secure-)?next-auth\.session-token(\.\d+)?$/;

/**
 * Expire every session cookie the request carried, on this response.
 *
 * For the one response after which a session must not be presented again by
 * the browser that asked: an account deletion (#370). The server has already
 * made the token worthless (its session row is gone, so `checkSession`
 * refuses it); this makes the browser drop it now instead of on the next
 * sign-out.
 *
 * Attributes match next-auth's own (`path=/`, HttpOnly, SameSite=Lax, Secure
 * for the `__Secure-` name), or the browser keeps the original cookie and
 * stores a second one beside it.
 */
export function expireSessionCookies<R extends NextResponse>(res: R, req: NextRequest): R {
  for (const { name } of req.cookies.getAll()) {
    if (!SESSION_COOKIE.test(name)) continue;
    res.cookies.set(name, '', {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: name.startsWith('__Secure-'),
      maxAge: 0,
    });
  }
  return res;
}
