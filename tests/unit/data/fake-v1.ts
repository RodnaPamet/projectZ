/**
 * A stand-in for `fetch` in jsdom, which has none (measured: `typeof fetch` is
 * "undefined" under jest-environment-jsdom 30). It records every request and
 * answers from a handler, with just the Response surface `v1Fetch` reads:
 * `status`, `ok`, `headers.get` and `text()`.
 *
 * Shared by tests/unit/data and the rendered data-* / moderation-queue suites.
 */

export interface FakeCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

export interface FakeAnswer {
  status?: number;
  /** Sent as JSON. `undefined` with a 2xx is an empty body. */
  body?: unknown;
  headers?: Record<string, string>;
}

export type FakeHandler = (call: FakeCall) => FakeAnswer | Promise<FakeAnswer>;

export function fakeResponse({ status = 200, body, headers = {} }: FakeAnswer) {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name: string) => lower[name.toLowerCase()] ?? null },
    text: async () => (body === undefined ? '' : JSON.stringify(body)),
  };
}

/** Install the fake on `globalThis.fetch`. Returns the live list of calls. */
export function installFakeFetch(handler: FakeHandler): FakeCall[] {
  const calls: FakeCall[] = [];
  globalThis.fetch = jest.fn(async (input: unknown, init?: RequestInit) => {
    const call: FakeCall = {
      url: String(input),
      method: init?.method ?? 'GET',
      headers: { ...(init?.headers as Record<string, string> | undefined) },
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    if (init?.signal?.aborted) {
      throw Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' });
    }
    return fakeResponse(await handler(call));
  }) as unknown as typeof fetch;
  return calls;
}

/** v1's success envelope. */
export const ok = (data: unknown, status = 200): FakeAnswer => ({ status, body: { data } });

/** v1's error envelope. */
export const fail = (status: number, code: string, message = code): FakeAnswer => ({
  status,
  body: { error: { code, message, requestId: 'req_test' } },
});

/** Resolve after the current microtasks and one macrotask. */
export const tick = () => new Promise((r) => setTimeout(r, 0));
