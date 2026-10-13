import { act, render, screen, waitFor } from '@testing-library/react';

import {
  messageEventFrom,
  RealtimeProvider,
  useMessageEvents,
  useRealtimeConnected,
} from '@/lib/realtime/client';

/**
 * Chat push in the browser (#481): connects only when the server says so, to
 * the URL the token route names, on the person's own channel; a message event
 * reaches the screens that listen; the connected flag follows the subscription.
 */
type Handler = (ctx?: unknown) => void;

const created: FakeClient[] = [];
class FakeSub {
  handlers: Record<string, Handler> = {};
  constructor(readonly channel: string) {}
  on(event: string, h: Handler) {
    this.handlers[event] = h;
    return this;
  }
  subscribe = jest.fn();
}
class FakeClient {
  subs: FakeSub[] = [];
  handlers: Record<string, Handler> = {};
  constructor(
    readonly url: string,
    readonly opts: { token: string },
  ) {
    created.push(this);
  }
  newSubscription(channel: string) {
    const s = new FakeSub(channel);
    this.subs.push(s);
    return s;
  }
  on(event: string, h: Handler) {
    this.handlers[event] = h;
    return this;
  }
  connect = jest.fn();
  disconnect = jest.fn();
}
jest.mock('centrifuge', () => ({ Centrifuge: FakeClient }), { virtual: false });

const USER = 'cuser0000000000000000000000';
const fetchMock = jest.fn();

function Probe({ seen }: { seen: string[] }) {
  const connected = useRealtimeConnected();
  useMessageEvents((e) => seen.push(e.conversationId));
  return <p data-testid="state">{connected ? 'live' : 'polling'}</p>;
}

beforeEach(() => {
  created.length = 0;
  fetchMock.mockReset().mockResolvedValue({
    ok: true,
    json: async () => ({
      data: { token: 'tok', url: 'wss://staging.playerz.bg/connection/websocket' },
    }),
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

describe('RealtimeProvider', () => {
  it('opens nothing when push is off', async () => {
    render(
      <RealtimeProvider userId={USER} enabled={false}>
        <Probe seen={[]} />
      </RealtimeProvider>,
    );
    await act(async () => {});
    expect(fetchMock).not.toHaveBeenCalled();
    expect(created).toHaveLength(0);
    expect(screen.getByTestId('state')).toHaveTextContent('polling');
  });

  it("connects to the token route's URL, on the person's own channel, and hands events on", async () => {
    const seen: string[] = [];
    render(
      <RealtimeProvider userId={USER} enabled>
        <Probe seen={seen} />
      </RealtimeProvider>,
    );
    await waitFor(() => expect(created).toHaveLength(1));
    const client = created[0]!;
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/realtime/token',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(client.url).toBe('wss://staging.playerz.bg/connection/websocket');
    expect(client.subs.map((s) => s.channel)).toEqual([`notif:${USER}`]);
    expect(client.connect).toHaveBeenCalled();

    const sub = client.subs[0]!;
    act(() => sub.handlers.subscribed!());
    expect(screen.getByTestId('state')).toHaveTextContent('live');

    act(() => sub.handlers.publication!({ data: { type: 'message', conversationId: 'cconv1' } }));
    act(() => sub.handlers.publication!({ data: { type: 'other' } }));
    expect(seen).toEqual(['cconv1']);

    act(() => client.handlers.disconnected!());
    expect(screen.getByTestId('state')).toHaveTextContent('polling');
  });

  it('does not connect when the server has no socket URL', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ data: { token: 'tok', url: null } }),
    });
    render(
      <RealtimeProvider userId={USER} enabled>
        <Probe seen={[]} />
      </RealtimeProvider>,
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await act(async () => {});
    expect(created).toHaveLength(0);
  });

  it('disconnects on unmount', async () => {
    const view = render(
      <RealtimeProvider userId={USER} enabled>
        <Probe seen={[]} />
      </RealtimeProvider>,
    );
    await waitFor(() => expect(created).toHaveLength(1));
    view.unmount();
    expect(created[0]!.disconnect).toHaveBeenCalled();
  });
});

describe('messageEventFrom', () => {
  it('accepts only a message event with a conversation id', () => {
    expect(messageEventFrom({ type: 'message', conversationId: 'c1' })).toEqual({
      conversationId: 'c1',
    });
    expect(messageEventFrom({ type: 'message' })).toBeNull();
    expect(messageEventFrom({ type: 'read', conversationId: 'c1' })).toBeNull();
    expect(messageEventFrom(null)).toBeNull();
    expect(messageEventFrom('message')).toBeNull();
  });
});
