'use client';

import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { useSWRConfig } from 'swr';
import { unstable_serialize, type SWRInfiniteKeyedMutator } from 'swr/infinite';

import { ApiClientError } from './errors';
import { v1Fetch, type V1FetchInit } from './fetcher';
import type { InfiniteKey, V1Page } from './keys';
import { useViewerId } from './provider';

/**
 * A write to `/api/v1`, with an optional optimistic change to one cached read.
 *
 * ═══ THE TARGET ═══
 *
 *   { key }                 a plain `useV1SWR` key.
 *   { infinite, getKey }    a `useV1SWRInfinite` list: its bound `mutate`, and
 *                           the `getKey` it was built with.
 *
 * The infinite form takes the BOUND mutate because SWR 2.4.2's global matcher
 * mutate skips `$inf$` keys outright (config-context: `/^\$(inf|sub)\$/`), and
 * both of this layer's first consumers — the moderation queue and a player's
 * bookings — are cursor lists. A matcher-based refresh would silently do
 * nothing to exactly the reads that need it.
 *
 * ═══ THE UPDATER SEES WHAT IS ON SCREEN ═══
 *
 * SWR hands `optimisticData` two values: the last COMMITTED one and the one
 * DISPLAYED. The committed one is the wrong base twice over:
 *   - on a cold cache it is `undefined`, so an updater that appends to it
 *     replaces the page with one row (the cold-cache race);
 *   - while an earlier optimistic change is still showing, it is the value from
 *     BEFORE that change, so the second removal resurrects the first row.
 * So `update` receives `displayed ?? fallback` — the pages array, for a list.
 *
 * ═══ populateCache: false ═══
 *
 * The server's answer to a write is not the list (a resolve returns a
 * resolution, not the queue), so it is never written into the cache: what was
 * shown optimistically stays, and `revalidate` decides whether the truth is
 * re-read. SWR 2.4.2 clears its pre-mutation backup once the mutation ends
 * (internalMutate, after `startRevalidate`), so a second change after a
 * successful first rolls back to the first, not before it — pinned in
 * tests/rendered/data-hooks.test.tsx.
 *
 * An error the caller says to KEEP (`keepOnError`) resolves the promise SWR
 * sees, so SWR takes its success path and does not roll back; the error is
 * re-thrown to the caller afterwards.
 *
 * ═══ A LIST'S PAGES ARE CACHED TWICE ═══
 *
 * `useSWRInfinite` keeps each page under its own key AND the array under the
 * `$inf$` key, and an optimistic change reaches only the array. On the next
 * `setSize`, SWR rebuilds the array FROM THE PAGE KEYS (the removed row comes
 * back) and refetches any page whose copies disagree — page 0, an extra read
 * that, on the moderation queue, is an extra audit row. So once a list has no
 * write in flight, its page keys are rewritten from the committed array.
 *
 * ═══ ONE ID PER TRIGGER ═══
 *
 * Each trigger mints one `crypto.randomUUID()`: it is the temp id an optimistic
 * row can carry, and the `Idempotency-Key` (POST /bookings requires one, and
 * replays the first booking for a repeated key). `retry()` re-sends the last
 * failed trigger with the SAME id, so a retry after a lost response cannot book
 * twice.
 *
 * It never toasts. A mutation's failure is the caller's to show, in the place
 * the person is looking.
 */

type Method = NonNullable<V1FetchInit['method']>;

export type MutationTarget<Data> =
  | { key: string }
  | {
      infinite: SWRInfiniteKeyedMutator<Data>;
      getKey: InfiniteKey<unknown>;
    };

export interface V1MutationOptions<Arg, Result, Data> {
  url: (arg: Arg) => string;
  method?: Exclude<Method, 'GET'>;
  body?: (arg: Arg, ctx: { id: string }) => unknown;
  /** The read to change optimistically. Omit for a write with no cached view. */
  target?: MutationTarget<Data>;
  /** Pure: the value on screen (or `fallback`) → the value to show now. */
  update?: (visible: Data, arg: Arg, ctx: { id: string }) => Data;
  /** The base for `update` when nothing is cached yet. */
  fallback?: Data;
  /**
   * Re-read the target after a successful write. Default true. False for an
   * audited read, where the re-read is a record nobody asked for.
   */
  revalidate?: boolean;
  /**
   * An error that means "the world already agrees with the optimistic change"
   * (CASE_ALREADY_RESOLVED: somebody else removed the row). It is kept on
   * screen and committed, and the error is still thrown for the caller to say so.
   */
  keepOnError?: (error: ApiClientError) => boolean;
  /** Reads to refresh after a successful write. */
  related?: {
    /** Plain keys, e.g. `clubKeys(slug)`. */
    keys?: (key: unknown) => boolean;
    /** Cursor lists, by the `getKey` they were built with. */
    infinite?: ReadonlyArray<InfiniteKey<unknown>>;
  };
}

type GlobalMutate = ReturnType<typeof useSWRConfig>['mutate'];

/** Rewrite each page key from the committed array — see the header. */
function syncPages(mutate: GlobalMutate, getKey: InfiniteKey<unknown>, pages: unknown) {
  if (!Array.isArray(pages)) return;
  let previous: V1Page<unknown> | null = null;
  for (const [i, page] of (pages as V1Page<unknown>[]).entries()) {
    const key = getKey(i, previous);
    if (key) void mutate(key, page, { revalidate: false });
    previous = page;
  }
}

/**
 * A v4 UUID. `crypto.randomUUID` exists only in a secure context, so a phone
 * testing the dev server over the LAN (`http://192.168.…`) has none, and every
 * write would throw before it was sent. `getRandomValues` has no such limit.
 */
function newId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Writes in flight per list, across hook instances. */
const inFlight = new Map<string, number>();

const asClientError = (e: unknown) =>
  e instanceof ApiClientError
    ? e
    : new ApiClientError({ status: 0, code: 'UNKNOWN', message: String(e) });

export function useV1Mutation<Arg, Result = unknown, Data = unknown>(
  options: V1MutationOptions<Arg, Result, Data>,
) {
  const viewerId = useViewerId();
  const { mutate, cache } = useSWRConfig();
  const [pending, setPending] = useState(0);
  const [error, setError] = useState<ApiClientError | null>(null);
  const lastFailed = useRef<{ arg: Arg; id: string } | null>(null);
  // The latest options, so `trigger` stays stable across renders. Written in a
  // layout effect, not during render: a ref written while rendering is a value
  // a discarded concurrent render can leave behind.
  const opts = useRef(options);
  useLayoutEffect(() => {
    opts.current = options;
  });

  const run = useCallback(
    async (arg: Arg, id: string): Promise<Result | undefined> => {
      const o = opts.current;
      setPending((n) => n + 1);
      setError(null);

      const request = v1Fetch<Result>(o.url(arg), {
        method: o.method ?? 'POST',
        body: o.body?.(arg, { id }),
        viewerId,
        idempotencyKey: id,
      });

      // A kept error resolves the promise SWR sees, so SWR takes its success
      // path (no rollback) — and is re-thrown below.
      let kept: ApiClientError | null = null;
      const settled = request.catch((e: unknown) => {
        const err = asClientError(e);
        if (o.keepOnError?.(err)) {
          kept = err;
          return undefined;
        }
        throw err;
      });

      const target = o.target;
      const infKey = target && 'infinite' in target ? unstable_serialize(target.getKey) : null;
      if (infKey) inFlight.set(infKey, (inFlight.get(infKey) ?? 0) + 1);

      try {
        let result: Result | undefined;
        if (target && o.update) {
          const mutatorOptions = {
            optimisticData: (_committed: Data | undefined, displayed: Data | undefined) =>
              o.update!((displayed ?? o.fallback) as Data, arg, { id }),
            rollbackOnError: true,
            populateCache: false,
            revalidate: o.revalidate ?? true,
            throwOnError: true,
          };
          if ('infinite' in target) {
            await target.infinite(settled as Promise<never>, mutatorOptions);
          } else {
            await mutate(target.key, settled as Promise<never>, mutatorOptions);
          }
          result = await settled;
        } else {
          result = await settled;
          if (target && (o.revalidate ?? true)) {
            await ('infinite' in target ? target.infinite() : mutate(target.key));
          }
        }

        if (kept) throw kept;

        lastFailed.current = null;
        if (o.related?.keys) void mutate(o.related.keys);
        for (const getKey of o.related?.infinite ?? []) void mutate(unstable_serialize(getKey));
        return result;
      } catch (e) {
        const err = asClientError(e);
        if (err !== kept) lastFailed.current = { arg, id };
        setError(err);
        throw err;
      } finally {
        if (infKey && target && 'infinite' in target) {
          const left = (inFlight.get(infKey) ?? 1) - 1;
          if (left > 0) inFlight.set(infKey, left);
          else {
            inFlight.delete(infKey);
            syncPages(mutate, target.getKey, cache.get(infKey)?.data);
          }
        }
        setPending((n) => n - 1);
      }
    },
    [cache, mutate, viewerId],
  );

  const trigger = useCallback((arg: Arg) => run(arg, newId()), [run]);

  /** Re-send the last failed trigger with its original id. */
  const retry = useCallback(() => {
    const last = lastFailed.current;
    return last ? run(last.arg, last.id) : Promise.resolve(undefined);
  }, [run]);

  const reset = useCallback(() => setError(null), []);

  return { trigger, retry, reset, error, isMutating: pending > 0 };
}
