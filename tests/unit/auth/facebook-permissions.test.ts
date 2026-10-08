/**
 * @jest-environment node
 */
import { createHmac } from 'node:crypto';

import {
  emailPermissionFrom,
  FACEBOOK_EMAIL_REQUIRED_REDIRECT,
  FACEBOOK_EMAIL_UNAVAILABLE_REDIRECT,
  FACEBOOK_GRAPH_VERSION,
  facebookNoEmailRedirect,
} from '@/lib/auth/facebook';
import { readFacebookEmailPermission } from '@/lib/auth/facebook-permissions';

/**
 * WHICH OF THE TWO "NO EMAIL" REFUSALS A PERSON SEES (#361).
 *
 * The first real Facebook sign-in (2026-10-08) brought no address although the
 * person had allowed email: their Facebook page for the app listed "Email
 * address" as shared. The sign-in page could only say "allow access and try
 * again", and trying again ended on the same page. The grant, read with the
 * sign-in's own token, tells the two causes apart.
 */

const grant = (...rows: Array<[string, string]>) => ({
  data: rows.map(([permission, status]) => ({ permission, status })),
});

describe('emailPermissionFrom', () => {
  it.each([
    [grant(['public_profile', 'granted'], ['email', 'granted']), 'granted'],
    [grant(['public_profile', 'granted'], ['email', 'declined']), 'declined'],
    [grant(['email', 'expired']), 'declined'],
    [grant(['public_profile', 'granted']), 'not-requested'],
    [grant(['email', 'something-new']), 'unknown'],
    [{ error: { message: 'Invalid OAuth access token' } }, 'unknown'],
    [null, 'unknown'],
    ['not a grant', 'unknown'],
  ])('%j is %s', (body, expected) => {
    expect(emailPermissionFrom(body)).toBe(expected);
  });
});

describe('facebookNoEmailRedirect', () => {
  it('sends an ALLOWED email to "Facebook has no address", which offers no retry', () => {
    expect(facebookNoEmailRedirect('granted')).toBe(FACEBOOK_EMAIL_UNAVAILABLE_REDIRECT);
    // Through next-auth's sign-in route, like the other refusal, so the
    // destination (an invitation's ?next=) survives it.
    expect(FACEBOOK_EMAIL_UNAVAILABLE_REDIRECT).toBe(
      '/api/auth/signin?error=FacebookEmailUnavailable',
    );
  });

  it.each(['declined', 'not-requested', 'unknown'] as const)(
    'sends %s to "allow access and try again"',
    (permission) => {
      expect(facebookNoEmailRedirect(permission)).toBe(FACEBOOK_EMAIL_REQUIRED_REDIRECT);
    },
  );
});

describe('readFacebookEmailPermission', () => {
  const ORIGINAL_SECRET = process.env.FACEBOOK_CLIENT_SECRET;
  afterEach(() => {
    if (ORIGINAL_SECRET === undefined) delete process.env.FACEBOOK_CLIENT_SECRET;
    else process.env.FACEBOOK_CLIENT_SECRET = ORIGINAL_SECRET;
  });

  type Call = [URL | string, { headers?: Record<string, string>; signal?: AbortSignal }?];
  const answering = (body: unknown, status = 200) =>
    jest.fn(async (..._args: Call) => ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    }));

  it('asks Graph for the grant with the token in the header, never in the URL', async () => {
    process.env.FACEBOOK_CLIENT_SECRET = 'app-secret';
    const fetchImpl = answering(grant(['email', 'granted']));

    await expect(
      readFacebookEmailPermission('user-token', fetchImpl as unknown as typeof fetch),
    ).resolves.toBe('granted');

    const [url, init] = fetchImpl.mock.calls[0]!;
    const asked = new URL(String(url));
    expect(`${asked.origin}${asked.pathname}`).toBe(
      `https://graph.facebook.com/${FACEBOOK_GRAPH_VERSION}/me/permissions`,
    );
    expect(String(url)).not.toContain('user-token');
    expect(init?.headers?.Authorization).toBe('Bearer user-token');
    // What Graph demands of server calls when the app turns on "Require app
    // secret"; ignored when it is off.
    expect(asked.searchParams.get('appsecret_proof')).toBe(
      createHmac('sha256', 'app-secret').update('user-token').digest('hex'),
    );
    // Bounded: the lookup only chooses the words of a refusal.
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('sends no proof when no secret is configured', async () => {
    delete process.env.FACEBOOK_CLIENT_SECRET;
    const fetchImpl = answering(grant(['email', 'declined']));

    await expect(
      readFacebookEmailPermission('user-token', fetchImpl as unknown as typeof fetch),
    ).resolves.toBe('declined');
    expect(new URL(String(fetchImpl.mock.calls[0]![0])).searchParams.has('appsecret_proof')).toBe(
      false,
    );
  });

  it('is unknown without a token, and asks nothing', async () => {
    const fetchImpl = answering(grant(['email', 'granted']));

    await expect(
      readFacebookEmailPermission(undefined, fetchImpl as unknown as typeof fetch),
    ).resolves.toBe('unknown');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('is unknown, never a throw, when Graph refuses or the network fails', async () => {
    const refusing = answering({ error: { message: 'Invalid OAuth access token' } }, 400);
    await expect(
      readFacebookEmailPermission('user-token', refusing as unknown as typeof fetch),
    ).resolves.toBe('unknown');

    const failing = jest.fn(async () => {
      throw new TypeError('fetch failed');
    });
    await expect(
      readFacebookEmailPermission('user-token', failing as unknown as typeof fetch),
    ).resolves.toBe('unknown');
  });
});
