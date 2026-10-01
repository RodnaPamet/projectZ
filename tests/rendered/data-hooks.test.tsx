import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { SWRConfig } from 'swr';

import { __resetSessionExpiryForTests, markSessionExpired } from '@/lib/auth/session-expiry';
import type { ApiClientError } from '@/lib/data/errors';
import { KEYS, type V1Page } from '@/lib/data/keys';
import { DataProvider, ViewerScope } from '@/lib/data/provider';
import { useV1Mutation } from '@/lib/data/use-v1-mutation';
import { needsSkeleton, useV1SWR, useV1SWRInfinite } from '@/lib/data/use-v1-swr';
import { __resetViewerForTests, isViewerChanged } from '@/lib/data/viewer';

import { fail, installFakeFetch, ok, tick, type FakeCall } from '../unit/data/fake-v1';

/**
 * The client data layer against a fake v1 (tests/unit/data/fake-v1.ts).
 *
 * Every test gets its own SWR cache (`provider: () => new Map()`), so nothing
 * one test caches is another's starting state. Real timers throughout: the
 * hooks are given `dedupingInterval: 0` and `focusThrottleInterval: 0` where an
 * event must be able to fire a second read — which also proves the seam wins
 * over a hook's own options.
 */

const QUICK = { dedupingInterval: 0, focusThrottleInterval: 0 };

function wrapper(viewerId?: string) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <DataProvider>
        <SWRConfig value={{ provider: () => new Map() }}>
          {viewerId ? <ViewerScope viewerId={viewerId}>{children}</ViewerScope> : children}
        </SWRConfig>
      </DataProvider>
    );
  };
}

const gets = (calls: FakeCall[]) => calls.filter((c) => c.method === 'GET');

const focus = async () => {
  await act(async () => {
    window.dispatchEvent(new Event('focus'));
    await tick();
    await tick();
  });
};

beforeEach(() => {
  __resetSessionExpiryForTests();
  __resetViewerForTests();
});

describe('useV1SWR', () => {
  it('reads, unwraps, sends the viewer, and shows a skeleton only on the first load', async () => {
    const calls = installFakeFetch(() => ok({ role: 'PLAYER' }));
    const { result } = renderHook(() => useV1SWR<{ role: string }>(KEYS.me('club')), {
      wrapper: wrapper('usr_1'),
    });

    expect(needsSkeleton(result.current)).toBe(true);
    await waitFor(() => expect(result.current.data).toEqual({ role: 'PLAYER' }));
    expect(needsSkeleton(result.current)).toBe(false);
    expect(calls[0]).toMatchObject({
      url: '/api/v1/t/club/me',
      headers: { 'x-playerz-viewer': 'usr_1' },
    });
  });

  it('a null key reads nothing', async () => {
    const calls = installFakeFetch(() => ok({}));
    renderHook(() => useV1SWR(null), { wrapper: wrapper() });
    await act(tick);
    expect(calls).toHaveLength(0);
  });

  it('revalidates on focus by default — the control for the seam tests below', async () => {
    const calls = installFakeFetch(() => ok({ n: 1 }));
    const { result } = renderHook(() => useV1SWR(KEYS.me('club'), QUICK), {
      wrapper: wrapper(),
    });
    await waitFor(() => expect(result.current.data).toBeDefined());

    await focus();
    await waitFor(() => expect(gets(calls)).toHaveLength(2));
  });
});

describe('the session seam', () => {
  it('after expiry a focus issues no GET — even with revalidateOnFocus set on the hook', async () => {
    const calls = installFakeFetch(() => ok({ n: 1 }));
    const { result } = renderHook(
      () => useV1SWR(KEYS.me('club'), { ...QUICK, revalidateOnFocus: true }),
      { wrapper: wrapper() },
    );
    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(gets(calls)).toHaveLength(1);

    act(() => markSessionExpired());
    await focus();
    await focus();

    expect(gets(calls)).toHaveLength(1);
  });

  it('a reconnect after expiry issues no GET either', async () => {
    const calls = installFakeFetch(() => ok({ n: 1 }));
    const { result } = renderHook(() => useV1SWR(KEYS.me('club'), QUICK), {
      wrapper: wrapper(),
    });
    await waitFor(() => expect(result.current.data).toBeDefined());

    act(() => markSessionExpired());
    await act(async () => {
      window.dispatchEvent(new Event('online'));
      await tick();
      await tick();
    });

    expect(gets(calls)).toHaveLength(1);
  });

  it('a 409 VIEWER_CHANGED stops revalidation, and the error still lands', async () => {
    const calls = installFakeFetch(() => fail(409, 'VIEWER_CHANGED'));
    const { result } = renderHook(
      () =>
        useV1SWR(KEYS.me('club'), {
          ...QUICK,
          // Fast enough that a retry WOULD land inside this test.
          errorRetryInterval: 5,
        }),
      { wrapper: wrapper('usr_a') },
    );

    await waitFor(() => expect(result.current.error?.code).toBe('VIEWER_CHANGED'));
    expect(isViewerChanged()).toBe(true);

    await focus();
    await act(() => new Promise((r) => setTimeout(r, 120)));

    expect(gets(calls)).toHaveLength(1);
  });

  it('a 401 is not retried', async () => {
    const calls = installFakeFetch(() => fail(401, 'UNAUTHORIZED'));
    const { result } = renderHook(() => useV1SWR(KEYS.me('club'), { errorRetryInterval: 5 }), {
      wrapper: wrapper(),
    });
    await waitFor(() => expect(result.current.error?.status).toBe(401));
    await act(() => new Promise((r) => setTimeout(r, 120)));
    expect(gets(calls)).toHaveLength(1);
  });

  it('a retry scheduled BEFORE the session expired does not fire after it', async () => {
    // A 503 schedules a retry; another hook's 401 lands before the timer.
    const calls = installFakeFetch(() => fail(503, 'MODERATION_UNAVAILABLE'));
    const { result } = renderHook(() => useV1SWR(KEYS.me('club'), { errorRetryInterval: 200 }), {
      wrapper: wrapper(),
    });
    await waitFor(() => expect(result.current.error?.status).toBe(503));
    act(() => markSessionExpired());

    await act(() => new Promise((r) => setTimeout(r, 700)));
    expect(gets(calls)).toHaveLength(1);
  });

  it('without a stop, the same failure IS retried — the control', async () => {
    const calls = installFakeFetch(() => fail(503, 'MODERATION_UNAVAILABLE'));
    renderHook(() => useV1SWR(KEYS.me('club'), { errorRetryInterval: 5 }), {
      wrapper: wrapper(),
    });
    await waitFor(() => expect(gets(calls).length).toBeGreaterThan(1));
  });
});

// ── Optimistic writes ───────────────────────────────────────────────

interface Row {
  id: string;
  name: string;
}

describe('useV1Mutation on a plain key', () => {
  function useList() {
    const list = useV1SWR<Row[]>(KEYS.me('club'), { revalidateOnFocus: false });
    const add = useV1Mutation<string, Row, Row[]>({
      url: () => '/api/v1/t/club/things',
      body: (name, { id }) => ({ name, id }),
      target: { key: KEYS.me('club') },
      update: (rows, name, { id }) => [...rows, { id, name }],
      fallback: [],
      revalidate: false,
    });
    return { list, add };
  }

  it('shows the change at once, keeps it on success, and sends the id as Idempotency-Key', async () => {
    let release!: () => void;
    const calls = installFakeFetch(async (c) => {
      if (c.method === 'GET') return ok([{ id: 'a', name: 'A' }]);
      await new Promise<void>((r) => (release = r));
      return ok({ id: 'srv', name: 'B' }, 201);
    });
    const { result } = renderHook(useList, { wrapper: wrapper() });
    await waitFor(() => expect(result.current.list.data).toHaveLength(1));

    let done!: Promise<unknown>;
    act(() => {
      done = result.current.add.trigger('B');
    });
    await waitFor(() => expect(result.current.list.data).toHaveLength(2));
    const post = calls.find((c) => c.method === 'POST')!;
    const tempId = result.current.list.data![1]!.id;
    expect(post.headers['idempotency-key']).toBe(tempId);

    await act(async () => {
      release();
      await done;
    });
    // The server's body (`srv`) is NOT written into the list: it is not a list.
    expect(result.current.list.data!.map((r) => r.id)).toEqual(['a', tempId]);
    expect(gets(calls)).toHaveLength(1);
  });

  it('rolls back on failure and surfaces the error', async () => {
    installFakeFetch((c) =>
      c.method === 'GET' ? ok([{ id: 'a', name: 'A' }]) : fail(409, 'SLOT_TAKEN'),
    );
    const { result } = renderHook(useList, { wrapper: wrapper() });
    await waitFor(() => expect(result.current.list.data).toHaveLength(1));

    let caught: ApiClientError | undefined;
    await act(async () => {
      await result.current.add.trigger('B').catch((e) => (caught = e));
    });

    expect(caught?.code).toBe('SLOT_TAKEN');
    expect(result.current.add.error?.code).toBe('SLOT_TAKEN');
    expect(result.current.list.data).toEqual([{ id: 'a', name: 'A' }]);
  });

  it('a cold cache: the updater builds on the fallback, not on undefined', async () => {
    // The GET never answers, so nothing is cached when the write starts.
    installFakeFetch((c) =>
      c.method === 'GET' ? new Promise(() => {}) : ok({ id: 'srv', name: 'B' }, 201),
    );
    const seen: unknown[] = [];
    const { result } = renderHook(
      () => {
        const list = useV1SWR<Row[]>(KEYS.me('club'));
        // Read during render: SWR re-renders only for the fields a render
        // touched, and this test reads `data` only after the write.
        void list.data;
        const add = useV1Mutation<string, Row, Row[]>({
          url: () => '/api/v1/t/club/things',
          target: { key: KEYS.me('club') },
          update: (rows, name, { id }) => {
            seen.push(rows);
            return [...rows, { id, name }];
          },
          fallback: [],
          revalidate: false,
        });
        return { list, add };
      },
      { wrapper: wrapper() },
    );

    await act(async () => {
      await result.current.add.trigger('B');
    });
    expect(seen[0]).toEqual([]);
    expect(result.current.list.data).toHaveLength(1);
  });

  it('a second change builds on the first, and its rollback does not undo the first', async () => {
    let n = 0;
    installFakeFetch((c) => {
      if (c.method === 'GET') return ok([{ id: 'a', name: 'A' }]);
      n += 1;
      return n === 1 ? ok({}, 201) : fail(500, 'INTERNAL');
    });
    const { result } = renderHook(useList, { wrapper: wrapper() });
    await waitFor(() => expect(result.current.list.data).toHaveLength(1));

    await act(async () => {
      await result.current.add.trigger('B');
    });
    await act(async () => {
      await result.current.add.trigger('C').catch(() => {});
    });

    // C rolls back to the list WITH B: SWR cleared its pre-B backup when B's
    // mutation ended, although populateCache is false.
    expect(result.current.list.data!.map((r) => r.name)).toEqual(['A', 'B']);
  });

  it('retry() re-sends the failed write with the SAME Idempotency-Key', async () => {
    let n = 0;
    const calls = installFakeFetch((c) => {
      if (c.method === 'GET') return ok([]);
      n += 1;
      return n === 1 ? fail(503, 'ENGINE_UNAVAILABLE') : ok({}, 201);
    });
    const { result } = renderHook(useList, { wrapper: wrapper() });
    await waitFor(() => expect(result.current.list.data).toEqual([]));

    await act(async () => {
      await result.current.add.trigger('B').catch(() => {});
    });
    await act(async () => {
      await result.current.add.retry();
    });

    const posts = calls.filter((c) => c.method === 'POST');
    expect(posts).toHaveLength(2);
    expect(posts[1]!.headers['idempotency-key']).toBe(posts[0]!.headers['idempotency-key']);

    await act(async () => {
      await result.current.add.trigger('C');
    });
    const third = calls.filter((c) => c.method === 'POST')[2]!;
    expect(third.headers['idempotency-key']).not.toBe(posts[0]!.headers['idempotency-key']);
  });

  it('refreshes related plain keys after a success', async () => {
    const calls = installFakeFetch((c) =>
      c.method === 'GET' ? ok(c.url.endsWith('/me') ? [] : { other: true }) : ok({}, 201),
    );
    const { result } = renderHook(
      () => {
        const me = useV1SWR<Row[]>(KEYS.me('club'), { revalidateOnFocus: false });
        const venue = useV1SWR('/api/v1/t/club/venue-thing', {
          revalidateOnFocus: false,
          dedupingInterval: 0,
        });
        const add = useV1Mutation<string>({
          url: () => '/api/v1/t/club/things',
          related: { keys: (k) => k === '/api/v1/t/club/venue-thing' },
        });
        return { me, venue, add };
      },
      { wrapper: wrapper() },
    );
    await waitFor(() => expect(result.current.venue.data).toBeDefined());
    const before = gets(calls).filter((c) => c.url.endsWith('venue-thing')).length;

    await act(async () => {
      await result.current.add.trigger('x');
      await tick();
    });
    await waitFor(() =>
      expect(gets(calls).filter((c) => c.url.endsWith('venue-thing')).length).toBe(before + 1),
    );
  });
});

describe('useV1Mutation on an infinite list', () => {
  const page = (ids: string[], nextCursor: string | null): V1Page<Row> => ({
    items: ids.map((id) => ({ id, name: id.toUpperCase() })),
    nextCursor,
  });

  function serve(failRemove: (id: string) => boolean = () => false) {
    return installFakeFetch((c) => {
      if (c.method === 'GET') {
        return ok(c.url.includes('cursor=p2') ? page(['c', 'd'], null) : page(['a', 'b'], 'p2'));
      }
      const id = c.url.split('/').at(-2)!;
      return failRemove(id) ? fail(500, 'INTERNAL') : ok({}, 200);
    });
  }

  function useQueue() {
    const getKey = KEYS.moderationCases({ reason: 'twelve chars plus' });
    const list = useV1SWRInfinite<Row>(getKey, { audited: true });
    const remove = useV1Mutation<string, unknown, V1Page<Row>[]>({
      url: (id) => `/api/v1/platform/moderation/cases/${id}/resolve`,
      target: { infinite: list.mutate, getKey },
      update: (pages, id) =>
        pages.map((p) => ({ ...p, items: p.items.filter((r) => r.id !== id) })),
      fallback: [],
      revalidate: false,
    });
    return { list, remove };
  }

  const ids = (data: V1Page<Row>[] | undefined) => data?.flatMap((p) => p.items.map((r) => r.id));

  it('removes optimistically, keeps it on success, and re-reads nothing', async () => {
    const calls = serve();
    const { result } = renderHook(useQueue, { wrapper: wrapper() });
    await waitFor(() => expect(ids(result.current.list.data)).toEqual(['a', 'b']));

    await act(async () => {
      await result.current.remove.trigger('a');
    });

    expect(ids(result.current.list.data)).toEqual(['b']);
    expect(gets(calls)).toHaveLength(1);
  });

  it('two overlapping removals both show: the second builds on what is displayed', async () => {
    // Built on SWR's COMMITTED value instead, the second removal would start
    // from the list before the first, and `a` would reappear while both are
    // in flight.
    const held: Array<() => void> = [];
    installFakeFetch(async (c) => {
      if (c.method === 'GET') return ok(page(['a', 'b', 'c'], null));
      await new Promise<void>((r) => held.push(r));
      return ok({}, 200);
    });
    const { result } = renderHook(useQueue, { wrapper: wrapper() });
    await waitFor(() => expect(ids(result.current.list.data)).toEqual(['a', 'b', 'c']));

    const pending: Promise<unknown>[] = [];
    act(() => {
      pending.push(result.current.remove.trigger('a'));
    });
    await waitFor(() => expect(held).toHaveLength(1));
    act(() => {
      pending.push(result.current.remove.trigger('b'));
    });
    await waitFor(() => expect(held).toHaveLength(2));

    expect(ids(result.current.list.data)).toEqual(['c']);

    await act(async () => {
      held.forEach((r) => r());
      await Promise.all(pending);
    });
    expect(ids(result.current.list.data)).toEqual(['c']);
  });

  it('rolls back the list on failure', async () => {
    serve((id) => id === 'a');
    const { result } = renderHook(useQueue, { wrapper: wrapper() });
    await waitFor(() => expect(ids(result.current.list.data)).toEqual(['a', 'b']));

    await act(async () => {
      await result.current.remove.trigger('a').catch(() => {});
    });
    expect(ids(result.current.list.data)).toEqual(['a', 'b']);
  });

  it('after a removal, load-more reads exactly one page and the removed row stays gone', async () => {
    // Without the page-key sync, setSize rebuilds the array from the page keys
    // (bringing `a` back) and refetches page 0, whose copies now disagree.
    const calls = serve();
    const { result } = renderHook(useQueue, { wrapper: wrapper() });
    await waitFor(() => expect(ids(result.current.list.data)).toEqual(['a', 'b']));

    await act(async () => {
      await result.current.remove.trigger('a');
    });
    await act(async () => {
      await result.current.list.setSize(2);
    });

    expect(ids(result.current.list.data)).toEqual(['b', 'c', 'd']);
    expect(gets(calls).map((c) => c.url)).toEqual([
      '/api/v1/platform/moderation/cases?reason=twelve+chars+plus',
      '/api/v1/platform/moderation/cases?cursor=p2&reason=twelve+chars+plus',
    ]);
  });
});
