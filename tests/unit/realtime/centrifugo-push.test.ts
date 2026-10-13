/** @jest-environment node */

import { broadcast, publicSocketUrl, realtimeEnabled } from '@/lib/realtime/centrifugo';

/**
 * Chat push (#481): on only with both secrets, a socket URL on the
 * deployment's own origin, and a broadcast that never throws.
 */
const ENV = { ...process.env };
const fetchMock = jest.fn();

beforeEach(() => {
  process.env = { ...ENV };
  delete process.env.CENTRIFUGO_TOKEN_SECRET;
  delete process.env.CENTRIFUGO_API_KEY;
  process.env.NEXTAUTH_URL = 'https://staging.playerz.bg';
  fetchMock.mockReset();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});
afterAll(() => {
  process.env = ENV;
});

function turnOn() {
  process.env.CENTRIFUGO_TOKEN_SECRET = 'x'.repeat(32);
  process.env.CENTRIFUGO_API_KEY = 'k'.repeat(32);
}

describe('realtimeEnabled', () => {
  it('is off without both secrets', () => {
    expect(realtimeEnabled()).toBe(false);
    process.env.CENTRIFUGO_TOKEN_SECRET = 'x'.repeat(32);
    expect(realtimeEnabled()).toBe(false);
  });

  it('is on with both', () => {
    turnOn();
    expect(realtimeEnabled()).toBe(true);
  });
});

describe('publicSocketUrl', () => {
  it('is null while push is off', () => {
    expect(publicSocketUrl()).toBeNull();
  });

  it("is the deployment's own origin, over wss", () => {
    turnOn();
    expect(publicSocketUrl()).toBe('wss://staging.playerz.bg/connection/websocket');
    process.env.NEXTAUTH_URL = 'http://localhost:3000';
    expect(publicSocketUrl()).toBe('ws://localhost:3000/connection/websocket');
  });
});

describe('broadcast', () => {
  it('does nothing while push is off', async () => {
    await expect(broadcast(['notif:a'], { type: 'message' })).resolves.toEqual({
      delivered: false,
      degraded: false,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends one broadcast with every channel, authorised by the API key', async () => {
    turnOn();
    fetchMock.mockResolvedValue({ ok: true });
    await expect(
      broadcast(['notif:a', 'notif:b'], { type: 'message', conversationId: 'c1' }),
    ).resolves.toEqual({
      delivered: true,
      degraded: false,
    });
    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(init.body)).toEqual({
      method: 'broadcast',
      params: { channels: ['notif:a', 'notif:b'], data: { type: 'message', conversationId: 'c1' } },
    });
    expect(init.headers.Authorization).toBe(`apikey ${'k'.repeat(32)}`);
  });

  it('never throws when the broker is down', async () => {
    turnOn();
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(broadcast(['notif:a'], {})).resolves.toEqual({ delivered: false, degraded: true });
  });
});
