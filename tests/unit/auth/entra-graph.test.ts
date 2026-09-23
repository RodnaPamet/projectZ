import { fetchUserGroupsFromGraph } from '@/lib/auth/entra-graph';

/**
 * The Graph client's job is to be BOUNDED and HONEST.
 *
 * The implementation this is ported from has neither property: no timeout, no
 * retry, and a page cap it crosses silently. Each of these tests pins one of
 * the three fixes, and the last one is the important one — a truncated list
 * must never be reported as a complete one.
 */

const page = (ids: string[], nextLink?: string) => ({
  ok: true,
  status: 200,
  headers: new Headers(),
  json: async () => ({
    value: ids.map((id) => ({ id })),
    ...(nextLink ? { '@odata.nextLink': nextLink } : {}),
  }),
});

const err = (status: number, headers: Record<string, string> = {}) => ({
  ok: false,
  status,
  headers: new Headers(headers),
  json: async () => ({}),
});

/** Deterministic: no Math.random, no real clock, no real sleeping. */
const deps = (fetchImpl: unknown, clock = { t: 0 }) => ({
  fetchImpl: fetchImpl as typeof fetch,
  now: () => clock.t,
  random: () => 0.5,
  sleep: async (ms: number) => {
    clock.t += ms;
  },
});

describe('fetchUserGroupsFromGraph', () => {
  it('reads one page', async () => {
    const f = jest.fn().mockResolvedValue(page(['g1', 'g2']));

    await expect(fetchUserGroupsFromGraph('tok', deps(f))).resolves.toEqual({
      groups: ['g1', 'g2'],
      complete: true,
    });
  });

  it('follows @odata.nextLink', async () => {
    const f = jest
      .fn()
      .mockResolvedValueOnce(page(['g1'], 'https://graph.microsoft.com/next'))
      .mockResolvedValueOnce(page(['g2']));

    const r = await fetchUserGroupsFromGraph('tok', deps(f));

    expect(r).toEqual({ groups: ['g1', 'g2'], complete: true });
    expect(f).toHaveBeenCalledTimes(2);
  });

  it('asks Graph to filter to GROUPS, not every directory object', async () => {
    // Without the OData type-cast segment the response also carries directory
    // roles and administrative units. Their ids would then be matched against
    // group mappings — a mapping satisfiable by holding a directory role.
    const f = jest.fn().mockResolvedValue(page([]));

    await fetchUserGroupsFromGraph('tok', deps(f));

    expect(f.mock.calls[0]![0]).toContain('/microsoft.graph.group');
  });

  it('sends the delegated token as a bearer', async () => {
    const f = jest.fn().mockResolvedValue(page([]));

    await fetchUserGroupsFromGraph('tok-123', deps(f));

    const init = f.mock.calls[0]![1] as { headers: Record<string, string> };
    expect(init.headers.Authorization).toBe('Bearer tok-123');
  });

  it('retries a 429 and honours Retry-After', async () => {
    // Graph throttles routinely. Without a retry, one 429 becomes a WRONG
    // answer rather than a slow one — and a wrong answer here is a user who
    // does not get their role.
    const clock = { t: 0 };
    const f = jest
      .fn()
      .mockResolvedValueOnce(err(429, { 'retry-after': '2' }))
      .mockResolvedValueOnce(page(['g1']));

    const r = await fetchUserGroupsFromGraph('tok', deps(f, clock));

    expect(r).toEqual({ groups: ['g1'], complete: true });
    expect(clock.t).toBe(2000); // waited what Graph asked for, not its own guess
  });

  it('retries a 5xx', async () => {
    const f = jest
      .fn()
      .mockResolvedValueOnce(err(503))
      .mockResolvedValueOnce(page(['g1']));

    await expect(fetchUserGroupsFromGraph('tok', deps(f))).resolves.toEqual({
      groups: ['g1'],
      complete: true,
    });
  });

  it('does NOT retry a 403 — the token is wrong and will stay wrong', async () => {
    const f = jest.fn().mockResolvedValue(err(403));

    const r = await fetchUserGroupsFromGraph('tok', deps(f));

    expect(r).toMatchObject({ complete: false, reason: 'http' });
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('gives up after a bounded number of attempts', async () => {
    const f = jest.fn().mockResolvedValue(err(500));

    const r = await fetchUserGroupsFromGraph('tok', deps(f));

    expect(r.complete).toBe(false);
    expect(f).toHaveBeenCalledTimes(3);
  });

  it('reports incomplete rather than hanging sign-in past its budget', async () => {
    // This runs inside the sign-in path. Twenty pages at four seconds each
    // would be a minute and a half of a user staring at a spinner.
    const clock = { t: 0 };
    const f = jest.fn().mockImplementation(async () => {
      clock.t += 4000;
      return page(['g'], 'https://graph.microsoft.com/next');
    });

    const r = await fetchUserGroupsFromGraph('tok', deps(f, clock));

    expect(r.complete).toBe(false);
    expect(r.reason).toBe('budget');
  });

  it('NEVER reports a truncated list as complete', async () => {
    // THE test. The ported implementation returns a truncated list through the
    // same `return` as a complete one, so the caller cannot tell "this user is
    // in no mapped group" from "we stopped looking". With the gate enforced
    // those produce the same outcome — denied — from opposite facts.
    const clock = { t: 0 };
    const f = jest
      .fn()
      .mockImplementation(async () => page(['g'], 'https://graph.microsoft.com/next'));

    const r = await fetchUserGroupsFromGraph('tok', { ...deps(f, clock), now: () => 0 });

    expect(r.complete).toBe(false);
    expect(r.reason).toBe('too-many-pages');
    expect(r.groups.length).toBeGreaterThan(0); // partial, and says so
  });

  it('survives a transport failure without throwing into the sign-in callback', async () => {
    const f = jest.fn().mockRejectedValue(new Error('ECONNRESET'));

    const r = await fetchUserGroupsFromGraph('tok', deps(f));

    expect(r).toMatchObject({ groups: [], complete: false, reason: 'network' });
  });
});
