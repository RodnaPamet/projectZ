'use client';

import type { Centrifuge, PublicationContext } from 'centrifuge';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import { notificationChannel } from './channels';

/**
 * Chat push in the browser (#481).
 *
 * One connection per signed-in tab, to Centrifugo at the address the token
 * route names (the deployment's own origin). It subscribes to ONE channel, the
 * person's own `notif:` feed; the subscribe proxy (/api/v1/realtime/subscribe)
 * refuses anyone else's. An event there names a conversation and nothing more.
 *
 * ═══ EACH SCREEN RE-READS ITS OWN DATA ═══
 *
 * The provider doesn't touch the cache. Screens that show conversations
 * subscribe with `useMessageEvents` and call their own `mutate()`: the inbox
 * list, the unread count, the open conversation. Each reads back through the
 * API that decides what this person may see. A global matcher can't do this:
 * SWR's skips cursor lists (`$inf$` keys), and only src/lib/data may import
 * swr anyway.
 *
 * ═══ POLLING STAYS, SLOWER ═══
 *
 * `useRealtimeConnected()` tells the chat screens the socket is up, and they
 * stretch their own refresh to a fallback interval. If the socket drops,
 * they're back to the fast interval before the reconnect has even started.
 * Push only ever makes things sooner, never required.
 *
 * ═══ NOTHING WHEN OFF ═══
 *
 * `enabled` comes from the server (push configured AND messaging switched
 * on). False, this renders its children and opens nothing. The client library
 * is imported on demand, after the token says push is on.
 */

export interface MessageEvent {
  conversationId: string;
}

type Listener = (event: MessageEvent) => void;

interface RealtimeValue {
  connected: boolean;
  listen: (listener: Listener) => () => void;
}

const NONE: RealtimeValue = { connected: false, listen: () => () => {} };
const RealtimeContext = createContext<RealtimeValue>(NONE);

/** True while this tab's socket is connected and subscribed. */
export function useRealtimeConnected(): boolean {
  return useContext(RealtimeContext).connected;
}

/** Call `onEvent` for every message event pushed to this person (#481). */
export function useMessageEvents(onEvent: Listener): void {
  const { listen } = useContext(RealtimeContext);
  const ref = useRef(onEvent);
  useEffect(() => {
    ref.current = onEvent;
  });
  useEffect(() => listen((e) => ref.current(e)), [listen]);
}

interface TokenAnswer {
  data?: { token?: string; url?: string | null };
}

async function fetchToken(): Promise<TokenAnswer['data'] | null> {
  const res = await fetch('/api/v1/realtime/token', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
  });
  if (!res.ok) return null;
  return ((await res.json()) as TokenAnswer).data ?? null;
}

/** What a publication carries, checked: anything else is ignored. */
export function messageEventFrom(data: unknown): MessageEvent | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as { type?: unknown; conversationId?: unknown };
  if (d.type !== 'message' || typeof d.conversationId !== 'string') return null;
  return { conversationId: d.conversationId };
}

export function RealtimeProvider({
  userId,
  enabled,
  children,
}: {
  userId: string;
  enabled: boolean;
  children: React.ReactNode;
}) {
  const [connected, setConnected] = useState(false);
  const listeners = useRef(new Set<Listener>());

  useEffect(() => {
    if (!enabled) return;
    let client: Centrifuge | null = null;
    let cancelled = false;

    void (async () => {
      const first = await fetchToken().catch(() => null);
      if (cancelled || !first?.token || !first.url) return;
      // Loaded here, not at the top: a tab with push off never downloads it,
      // and the shell's own bundle stays inside its budget.
      const { Centrifuge: Client } = await import('centrifuge');
      if (cancelled) return;

      client = new Client(first.url, {
        token: first.token,
        // Called when the 15-minute token nears expiry, and on reconnect.
        getToken: async () => (await fetchToken())?.token ?? '',
      });
      const sub = client.newSubscription(notificationChannel(userId));
      sub.on('subscribed', () => setConnected(true));
      sub.on('unsubscribed', () => setConnected(false));
      sub.on('error', () => setConnected(false));
      sub.on('publication', (ctx: PublicationContext) => {
        const event = messageEventFrom(ctx.data);
        if (event) for (const l of listeners.current) l(event);
      });
      client.on('disconnected', () => setConnected(false));
      sub.subscribe();
      client.connect();
    })();

    return () => {
      cancelled = true;
      setConnected(false);
      client?.disconnect();
    };
  }, [enabled, userId]);

  // Stable, so a screen's subscription survives the connection flapping.
  const listen = useCallback((listener: Listener) => {
    listeners.current.add(listener);
    return () => {
      listeners.current.delete(listener);
    };
  }, []);
  const value = useMemo<RealtimeValue>(() => ({ connected, listen }), [connected, listen]);

  return <RealtimeContext.Provider value={value}>{children}</RealtimeContext.Provider>;
}
