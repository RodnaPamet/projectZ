import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { SWRConfig } from 'swr';

import type { NotificationDto } from '@/app/api/v1/_lib/dto';
import { badgeLabel, NotificationBell } from '@/components/layout/notification-bell';
import { TooltipProvider } from '@/components/ui/tooltip';
import { __resetSessionExpiryForTests } from '@/lib/auth/session-expiry';
import { DataProvider, ViewerScope } from '@/lib/data/provider';
import { __resetViewerForTests } from '@/lib/data/viewer';

import { messages, withIntl } from '../helpers/intl';
import { fail, installFakeFetch, ok, tick, type FakeAnswer } from '../unit/data/fake-v1';

/**
 * The bell's states (#367), against the real Bulgarian catalogue and a fake
 * v1: loading, empty, a list with an unread count, opening it (which marks
 * everything read and clears the count), a failed read, and "9+".
 */

const n = messages.common.nav;

const row = (id: string, over: Partial<NotificationDto> = {}): NotificationDto => ({
  id,
  kind: 'BOOKING_CONFIRMED',
  title: 'Резервацията е потвърдена',
  body: 'Sofia Padel, Корт 1 · пт, 9 окт., 19:00–20:30',
  href: `/me/bookings/b_${id}`,
  refType: 'booking',
  refId: `b_${id}`,
  read: false,
  readAt: null,
  createdAt: new Date(Date.now() - 5 * 60_000).toISOString(),
  ...over,
});

const page = (items: NotificationDto[], unreadCount = items.filter((i) => !i.read).length) =>
  ok({ items, nextCursor: null, unreadCount });

/** Wide enough that the vendored Popover is a dropdown jsdom can open. */
function desktopViewport() {
  window.matchMedia = ((query: string) => ({
    matches: query.includes('1024px') || query.includes('640px'),
    media: query,
    onchange: null,
    addListener: jest.fn(),
    removeListener: jest.fn(),
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
    dispatchEvent: jest.fn(),
  })) as unknown as typeof window.matchMedia;
}

function mount() {
  return render(
    withIntl(
      <DataProvider>
        <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
          <TooltipProvider>
            <ViewerScope viewerId="usr_player">
              <NotificationBell />
            </ViewerScope>
          </TooltipProvider>
        </SWRConfig>
      </DataProvider>,
    ),
  );
}

const bell = () => screen.getByTestId('header-notifications');

beforeEach(() => {
  __resetSessionExpiryForTests();
  __resetViewerForTests();
  desktopViewport();
});

describe('the bell', () => {
  it('while loading: no count, and the open list shows a skeleton', async () => {
    let release!: (a: FakeAnswer) => void;
    installFakeFetch(() => new Promise<FakeAnswer>((r) => (release = r)));
    mount();

    expect(bell()).toHaveAccessibleName(n.notifications);
    expect(screen.queryByTestId('notifications-count')).not.toBeInTheDocument();
    fireEvent.click(bell());
    expect(await screen.findByTestId('notifications-loading')).toBeInTheDocument();

    await act(async () => {
      release(page([]));
      await tick();
    });
    expect(await screen.findByTestId('notifications-empty')).toHaveTextContent(
      n.notificationsEmpty,
    );
  });

  it('nothing yet: "Нямате известия", no count', async () => {
    installFakeFetch(() => page([]));
    mount();
    await act(tick);
    expect(screen.queryByTestId('notifications-count')).not.toBeInTheDocument();
    fireEvent.click(bell());
    expect(await screen.findByTestId('notifications-empty')).toBeInTheDocument();
  });

  it('two unread: the count on the bell, named for a screen reader', async () => {
    installFakeFetch((c) => (c.method === 'GET' ? page([row('a'), row('b')]) : ok({})));
    mount();

    expect(await screen.findByTestId('notifications-count')).toHaveTextContent('2');
    expect(bell()).toHaveAccessibleName(n.notificationsUnread.replace('{count}', '2'));
  });

  it('opening lists newest first, links each to its booking, marks all read and clears the count', async () => {
    let unread = 2;
    const items = () => [
      row('a', { read: unread === 0, title: 'Играете след 3 часа', kind: 'BOOKING_REMINDER' }),
      row('b', { read: unread === 0 }),
      row('c', { read: true, title: 'Играта е отменена' }),
    ];
    const calls = installFakeFetch((c) => {
      if (c.method === 'POST') {
        unread = 0;
        return ok({ marked: 2, unreadCount: 0 });
      }
      return page(items(), unread);
    });
    mount();
    expect(await screen.findByTestId('notifications-count')).toHaveTextContent('2');

    fireEvent.click(bell());
    const list = await screen.findByTestId('notifications-list');
    const rows = within(list).getAllByTestId('notification-item');
    expect(rows.map((r) => r.textContent)).toEqual([
      expect.stringContaining('Играете след 3 часа'),
      expect.stringContaining('Резервацията е потвърдена'),
      expect.stringContaining('Играта е отменена'),
    ]);
    expect(within(rows[0]!).getByRole('link')).toHaveAttribute('href', '/me/bookings/b_a');
    // What was new when opened stays marked as new while the list is open.
    expect(rows.map((r) => r.dataset.unread ?? null)).toEqual(['true', 'true', null]);
    expect(rows[0]).toHaveTextContent('преди 5 минути');

    await waitFor(() =>
      expect(screen.queryByTestId('notifications-count')).not.toBeInTheDocument(),
    );
    const post = calls.find((c) => c.method === 'POST')!;
    expect(post.url).toBe('/api/v1/me/notifications/read');
    expect(post.body).toEqual({ all: true });
    expect(post.headers['x-playerz-viewer']).toBe('usr_player');
    expect(bell()).toHaveAccessibleName(n.notifications);
  });

  it('nothing unread: opening sends no write', async () => {
    const calls = installFakeFetch(() => page([row('a', { read: true })]));
    mount();
    await act(tick);
    fireEvent.click(bell());
    await screen.findByTestId('notifications-list');
    await act(tick);
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
  });

  it('a failed read: no count, an error in the list, and a retry that reads again', async () => {
    let failing = true;
    const calls = installFakeFetch(() => (failing ? fail(503, 'UNAVAILABLE') : page([])));
    mount();
    fireEvent.click(bell());
    expect(await screen.findByTestId('notifications-error')).toHaveTextContent(
      n.notificationsError,
    );
    expect(screen.queryByTestId('notifications-count')).not.toBeInTheDocument();

    failing = false;
    const before = calls.length;
    fireEvent.click(screen.getByRole('button', { name: n.notificationsRetry }));
    expect(await screen.findByTestId('notifications-empty')).toBeInTheDocument();
    expect(calls.length).toBeGreaterThan(before);
  });

  it('more than nine reads "9+"', async () => {
    installFakeFetch(() => page([row('a')], 12));
    mount();
    expect(await screen.findByTestId('notifications-count')).toHaveTextContent('9+');
    expect(bell()).toHaveAccessibleName(n.notificationsUnread.replace('{count}', '12'));
    expect([badgeLabel(1), badgeLabel(9), badgeLabel(10)]).toEqual(['1', '9', '9+']);
  });
});
