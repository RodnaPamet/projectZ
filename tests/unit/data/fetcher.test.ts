import { __resetSessionExpiryForTests, isSessionExpired } from '@/lib/auth/session-expiry';
import { ApiClientError } from '@/lib/data/errors';
import { v1Fetch } from '@/lib/data/fetcher';
import { __resetViewerForTests, isViewerChanged } from '@/lib/data/viewer';

import { fail, installFakeFetch, ok } from './fake-v1';

beforeEach(() => {
  __resetSessionExpiryForTests();
  __resetViewerForTests();
});

describe('v1Fetch', () => {
  it('unwraps the success envelope', async () => {
    installFakeFetch(() => ok({ id: 'b1' }));
    await expect(v1Fetch('/api/v1/t/club/me')).resolves.toEqual({ id: 'b1' });
  });

  it('a 204 and an empty 200 are undefined, not a JSON parse error', async () => {
    installFakeFetch(() => ({ status: 204 }));
    await expect(v1Fetch('/api/v1/x', { method: 'DELETE' })).resolves.toBeUndefined();

    installFakeFetch(() => ({ status: 200 }));
    await expect(v1Fetch('/api/v1/x', { method: 'POST' })).resolves.toBeUndefined();
  });

  it('throws ApiClientError with status, code, message, requestId and details as properties', async () => {
    installFakeFetch(() => ({
      status: 409,
      body: { error: { code: 'SLOT_TAKEN', message: 'taken', requestId: 'r1', details: { a: 1 } } },
    }));

    const err = await v1Fetch('/api/v1/t/c/bookings', { method: 'POST' }).catch((e) => e);
    expect(err).toBeInstanceOf(ApiClientError);
    expect(err).toMatchObject({
      status: 409,
      code: 'SLOT_TAKEN',
      message: 'taken',
      requestId: 'r1',
      details: { a: 1 },
    });
  });

  it('takes the request id from x-request-id when the body has none (the edge writes none)', async () => {
    installFakeFetch(() => ({
      status: 403,
      body: { error: { code: 'FORBIDDEN', message: 'Forbidden' } },
      headers: { 'X-Request-Id': 'from-header' },
    }));
    const err = (await v1Fetch('/api/v1/t/c/me').catch((e) => e)) as ApiClientError;
    expect(err.requestId).toBe('from-header');
  });

  it('a body that is not the envelope is UNKNOWN, with the status kept', async () => {
    installFakeFetch(() => ({ status: 502, body: 'Bad gateway' }));
    const err = (await v1Fetch('/api/v1/x').catch((e) => e)) as ApiClientError;
    expect(err).toMatchObject({ status: 502, code: 'UNKNOWN' });
  });

  it('a request that never got an answer is NETWORK, status 0', async () => {
    globalThis.fetch = jest.fn(async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;
    await expect(v1Fetch('/api/v1/x')).rejects.toMatchObject({ status: 0, code: 'NETWORK' });
  });

  it('an abort is passed through as itself, not wrapped', async () => {
    installFakeFetch(() => ok(null));
    const c = new AbortController();
    c.abort();
    const err = (await v1Fetch('/api/v1/x', { signal: c.signal }).catch((e) => e)) as Error;
    expect(err.name).toBe('AbortError');
    expect(err).not.toBeInstanceOf(ApiClientError);
  });

  it('sends the viewer, the idempotency key and a JSON body', async () => {
    const calls = installFakeFetch(() => ok({}));
    await v1Fetch('/api/v1/t/c/bookings', {
      method: 'POST',
      body: { a: 1 },
      viewerId: 'usr_1',
      idempotencyKey: 'k-1',
    });
    expect(calls[0]).toMatchObject({
      method: 'POST',
      body: { a: 1 },
      headers: {
        'x-playerz-viewer': 'usr_1',
        'idempotency-key': 'k-1',
        'content-type': 'application/json',
      },
    });
  });

  it('sends no viewer header when there is no viewer', async () => {
    const calls = installFakeFetch(() => ok({}));
    await v1Fetch('/api/v1/venues');
    expect(calls[0]!.headers).not.toHaveProperty('x-playerz-viewer');
  });

  describe('the two stores', () => {
    it('a 401 on an /api path marks the session expired', async () => {
      installFakeFetch(() => fail(401, 'UNAUTHORIZED'));
      await v1Fetch('/api/v1/platform/moderation/cases').catch(() => {});
      expect(isSessionExpired()).toBe(true);
    });

    it('a 401 under /api/auth does not — it is about a sign-in being attempted', async () => {
      installFakeFetch(() => fail(401, 'INVALID_CREDENTIALS'));
      await v1Fetch('/api/auth/callback/credentials').catch(() => {});
      expect(isSessionExpired()).toBe(false);
    });

    it('a 403 is not a session verdict', async () => {
      installFakeFetch(() => fail(403, 'FORBIDDEN'));
      await v1Fetch('/api/v1/t/c/me').catch(() => {});
      expect(isSessionExpired()).toBe(false);
    });

    it('409 VIEWER_CHANGED marks the viewer changed; another 409 does not', async () => {
      installFakeFetch(() => fail(409, 'SLOT_TAKEN'));
      await v1Fetch('/api/v1/t/c/bookings').catch(() => {});
      expect(isViewerChanged()).toBe(false);

      installFakeFetch(() => fail(409, 'VIEWER_CHANGED'));
      await v1Fetch('/api/v1/t/c/bookings').catch(() => {});
      expect(isViewerChanged()).toBe(true);
    });
  });
});
