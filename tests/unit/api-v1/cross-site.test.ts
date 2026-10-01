import { DOMAIN_ERROR_MAP, toV1ErrorResponse } from '@/app/api/v1/_lib/errors';
import {
  assertOwnOriginForCookieWrites,
  assertViewer,
  CrossSiteRequestError,
  ViewerChangedError,
} from '@/app/api/v1/_lib/request-guard';

/**
 * The two request checks in src/app/api/v1/_lib/request-guard.ts, on the
 * header shapes a browser and a native client actually send.
 * tests/integration/api-v1-cross-site.test.ts runs them through real routes.
 */

function req(
  method: string,
  opts: { site?: string; cookies?: string[]; viewer?: string; bearer?: boolean } = {},
) {
  const headers: Record<string, string> = {};
  if (opts.site) headers['sec-fetch-site'] = opts.site;
  if (opts.viewer !== undefined) headers['x-playerz-viewer'] = opts.viewer;
  if (opts.bearer) headers.authorization = 'Bearer x';
  return {
    method,
    headers: { get: (n: string) => headers[n.toLowerCase()] ?? null },
    cookies: { getAll: () => (opts.cookies ?? []).map((name) => ({ name, value: 'v' })) },
  } as never;
}

const SESSION = 'next-auth.session-token';

describe('a cookie-authenticated write must come from this origin', () => {
  it.each(['cross-site', 'same-site'])('refuses a cookie POST with Sec-Fetch-Site: %s', (site) => {
    // same-site too: SameSite=Lax sends the cookie from a sibling subdomain.
    expect(() => assertOwnOriginForCookieWrites(req('POST', { site, cookies: [SESSION] }))).toThrow(
      CrossSiteRequestError,
    );
  });

  it.each(['PUT', 'PATCH', 'DELETE'])('refuses every mutation verb: %s', (method) => {
    expect(() =>
      assertOwnOriginForCookieWrites(req(method, { site: 'cross-site', cookies: [SESSION] })),
    ).toThrow(CrossSiteRequestError);
  });

  it.each([
    '__Secure-next-auth.session-token',
    'next-auth.session-token.0',
    '__Secure-next-auth.session-token.1',
  ])('recognises the HTTPS and chunked cookie names: %s', (cookie) => {
    expect(() =>
      assertOwnOriginForCookieWrites(req('POST', { site: 'cross-site', cookies: [cookie] })),
    ).toThrow(CrossSiteRequestError);
  });

  it.each(['same-origin', 'none'])('allows Sec-Fetch-Site: %s', (site) => {
    expect(() =>
      assertOwnOriginForCookieWrites(req('POST', { site, cookies: [SESSION] })),
    ).not.toThrow();
  });

  it('allows a Bearer request with no session cookie, even cross-site', () => {
    // A token is not ambient credentials: nobody can make a victim's app send it.
    expect(() =>
      assertOwnOriginForCookieWrites(
        req('POST', { site: 'cross-site', bearer: true, cookies: ['NEXT_LOCALE'] }),
      ),
    ).not.toThrow();
  });

  it('allows a request with no Sec-Fetch-Site at all — native, curl, server-to-server', () => {
    expect(() => assertOwnOriginForCookieWrites(req('POST', { cookies: [SESSION] }))).not.toThrow();
  });

  it('never refuses a read', () => {
    expect(() =>
      assertOwnOriginForCookieWrites(req('GET', { site: 'cross-site', cookies: [SESSION] })),
    ).not.toThrow();
  });

  it('maps to 403 CROSS_SITE_REQUEST without naming the header', () => {
    const { status, payload } = toV1ErrorResponse(new CrossSiteRequestError('cross-site'));
    expect(status).toBe(403);
    expect(payload.error.code).toBe('CROSS_SITE_REQUEST');
    expect(payload.error.message).toBe(DOMAIN_ERROR_MAP.CrossSiteRequestError!.clientMessage);
  });
});

describe('the page’s viewer must be the signed-in user', () => {
  it('refuses a different user with 409 VIEWER_CHANGED', () => {
    expect(() => assertViewer(req('GET', { viewer: 'usr_a' }), 'usr_b')).toThrow(
      ViewerChangedError,
    );
    const { status, payload } = toV1ErrorResponse(new ViewerChangedError());
    expect(status).toBe(409);
    expect(payload.error.code).toBe('VIEWER_CHANGED');
  });

  it('passes the same user, no header, and an empty header', () => {
    expect(() => assertViewer(req('GET', { viewer: 'usr_a' }), 'usr_a')).not.toThrow();
    expect(() => assertViewer(req('GET'), 'usr_a')).not.toThrow();
    expect(() => assertViewer(req('GET', { viewer: '' }), 'usr_a')).not.toThrow();
  });

  it('leaves a signed-out caller to the route’s own 401', () => {
    expect(() => assertViewer(req('GET', { viewer: 'usr_a' }), null)).not.toThrow();
  });
});
