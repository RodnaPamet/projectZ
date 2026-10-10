import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { SWRConfig } from 'swr';

import type {
  ConversationDto,
  ConversationSummaryDto,
  MessageDto,
} from '@/app/api/v1/_lib/messaging';
import { ConversationView } from '@/components/messages/ConversationView';
import { InboxList } from '@/components/messages/InboxList';
import { PlayerCardView } from '@/components/messages/PlayerCardView';
import { TooltipProvider } from '@/components/ui/tooltip';
import { __resetSessionExpiryForTests } from '@/lib/auth/session-expiry';
import { DataProvider, ViewerScope } from '@/lib/data/provider';
import { __resetViewerForTests } from '@/lib/data/viewer';

import { messages, withIntl } from '../helpers/intl';
import { fail, installFakeFetch, ok } from '../unit/data/fake-v1';

/**
 * Messaging's screens (#375) against the REAL Bulgarian catalogue and a fake
 * v1: who wrote each line, what a request and a pending request look like,
 * sending, retracting, and the public card that never shows more than a name,
 * a picture and sports.
 */
const c = messages.messaging.conversation;
const ME = { kind: 'me' } as const;

const msg = (over: Partial<MessageDto>): MessageDto => ({
  id: 'm1',
  mine: false,
  fromClub: false,
  sender: { name: 'Мария', deleted: false, clubName: null },
  body: 'Здравейте',
  deleted: false,
  createdAt: '2026-10-10T10:00:00Z',
  ...over,
});

const conversation = (over: Partial<ConversationDto> = {}): ConversationDto => ({
  id: 'cv1',
  kind: 'player',
  counterpart: { kind: 'player', userId: 'u2', name: 'Мария', avatarUrl: null, deleted: false },
  state: 'active',
  blockedByMe: false,
  canSend: true,
  unreadCount: 0,
  olderCursor: null,
  messages: [msg({})],
  ...over,
});

function wrap(node: React.ReactNode) {
  return render(
    withIntl(
      <DataProvider>
        <SWRConfig value={{ provider: () => new Map() }}>
          <TooltipProvider>
            <ViewerScope viewerId="usr_me">{node}</ViewerScope>
          </TooltipProvider>
        </SWRConfig>
      </DataProvider>,
    ),
  );
}

beforeEach(() => {
  __resetSessionExpiryForTests();
  __resetViewerForTests();
});

describe('ConversationView', () => {
  it('names every sender, and a staff reply with its club', async () => {
    const seed = conversation({
      kind: 'club',
      counterpart: { kind: 'club', clubId: 't1', slug: 'levski', name: 'Тенис клуб Левски' },
      messages: [
        msg({ id: 'm1', mine: true, sender: { name: 'Аз', deleted: false, clubName: null } }),
        msg({
          id: 'm2',
          fromClub: true,
          sender: { name: 'Иван', deleted: false, clubName: 'Тенис клуб Левски' },
          body: 'Да, от 18:00',
        }),
        msg({
          id: 'm3',
          deleted: true,
          body: null,
          sender: { name: null, deleted: true, clubName: null },
        }),
      ],
    });
    installFakeFetch(() => ok(seed));
    wrap(<ConversationView side={ME} seed={seed} back={{ href: '/messages', label: c.back }} />);

    const rows = screen.getAllByTestId('conversation-message');
    expect(rows[0]).toHaveTextContent(c.you);
    expect(rows[1]).toHaveTextContent('Иван · Тенис клуб Левски');
    expect(rows[1]).toHaveTextContent('Да, от 18:00');
    expect(rows[2]).toHaveTextContent(messages.common.deletedUser);
    expect(rows[2]).toHaveTextContent(c.deleted);
    expect(screen.getByTestId('conversation-title')).toHaveTextContent('Тенис клуб Левски');
  });

  it('marks the conversation read once it has something from the other side', async () => {
    const seed = conversation();
    const calls = installFakeFetch(() => ok(seed));
    wrap(<ConversationView side={ME} seed={seed} back={{ href: '/messages', label: c.back }} />);
    await waitFor(() =>
      expect(
        calls.some((x) => x.method === 'POST' && x.url.endsWith('/conversations/cv1/read')),
      ).toBe(true),
    );
  });

  it('a request shows who asks, and Приеми / Откажи', () => {
    const seed = conversation({ state: 'request' });
    installFakeFetch(() => ok(seed));
    wrap(<ConversationView side={ME} seed={seed} back={{ href: '/messages', label: c.back }} />);
    expect(screen.getByTestId('conversation-notice-request')).toHaveTextContent('Мария');
    expect(screen.getByTestId('conversation-accept')).toHaveTextContent(c.accept);
    expect(screen.getByTestId('conversation-decline')).toHaveTextContent(c.decline);
  });

  it('a waiting request has no composer, and says why', () => {
    const seed = conversation({ state: 'pending', canSend: false });
    installFakeFetch(() => ok(seed));
    wrap(<ConversationView side={ME} seed={seed} back={{ href: '/messages', label: c.back }} />);
    expect(screen.queryByTestId('conversation-composer')).not.toBeInTheDocument();
    expect(screen.getByTestId('conversation-notice-pending')).toBeInTheDocument();
  });

  it('sends: the line shows at once, the draft clears, and a refusal puts the draft back', async () => {
    const seed = conversation({ messages: [] });
    let refuse = false;
    const calls = installFakeFetch((x) => {
      if (x.method === 'POST' && x.url.endsWith('/messages')) {
        return refuse ? fail(409, 'REQUEST_PENDING') : ok({ id: 'm9', replayed: false }, 201);
      }
      return ok(seed);
    });
    wrap(<ConversationView side={ME} seed={seed} back={{ href: '/messages', label: c.back }} />);

    const input = screen.getByTestId('conversation-input');
    fireEvent.change(input, { target: { value: 'Утре в 18?' } });
    fireEvent.click(screen.getByTestId('conversation-send'));
    expect(input).toHaveValue('');
    const sent = calls.find((x) => x.method === 'POST' && x.url.endsWith('/messages'));
    expect(sent?.body).toEqual({ body: 'Утре в 18?' });
    expect(sent?.headers['idempotency-key']).toBeTruthy();

    refuse = true;
    fireEvent.change(input, { target: { value: 'Ехо?' } });
    fireEvent.click(screen.getByTestId('conversation-send'));
    await waitFor(() => expect(input).toHaveValue('Ехо?'));
    expect(screen.getByTestId('conversation-send-error')).toHaveTextContent(
      c.sendError.REQUEST_PENDING,
    );
  });

  it('only my own lines can be removed, after asking', async () => {
    const seed = conversation({
      messages: [msg({ id: 'mine', mine: true }), msg({ id: 'theirs' })],
    });
    const calls = installFakeFetch(() => ok(seed));
    wrap(<ConversationView side={ME} seed={seed} back={{ href: '/messages', label: c.back }} />);
    const remove = screen.getAllByTestId('conversation-remove');
    expect(remove).toHaveLength(1);
    fireEvent.click(remove[0]!);
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: c.removeConfirm.yes }));
    await waitFor(() =>
      expect(calls.some((x) => x.method === 'DELETE' && x.url.endsWith('/messages/mine'))).toBe(
        true,
      ),
    );
  });
});

describe('InboxList', () => {
  const row = (over: Partial<ConversationSummaryDto>): ConversationSummaryDto => ({
    id: 'cv1',
    kind: 'player',
    counterpart: { kind: 'player', userId: 'u2', name: 'Мария', avatarUrl: null, deleted: false },
    state: 'active',
    lastMessageAt: '2026-10-10T10:00:00Z',
    lastMessage: { preview: 'Здравейте', mine: false, deleted: false },
    unreadCount: 2,
    ...over,
  });

  it('lists who, the last line and the unread count, and links each to its conversation', () => {
    const page = {
      items: [row({}), row({ id: 'cv2', unreadCount: 0, state: 'pending' })],
      nextCursor: null,
    };
    installFakeFetch(() => ok(page));
    wrap(<InboxList side={ME} seed={page} />);
    const rows = within(screen.getByTestId('inbox-list')).getAllByTestId('inbox-row');
    expect(rows[0]).toHaveAttribute('href', '/messages/cv1');
    expect(rows[0]).toHaveTextContent('Мария');
    expect(rows[0]).toHaveTextContent('Здравейте');
    expect(within(rows[0]!).getByTestId('inbox-unread')).toHaveTextContent('2');
    expect(rows[1]).toHaveTextContent(messages.messaging.inbox.pending);
  });

  it('an empty «Заявки» says what arrives there', () => {
    const page = { items: [], nextCursor: null };
    installFakeFetch(() => ok(page));
    wrap(<InboxList side={ME} tab="requests" seed={page} />);
    expect(screen.getByTestId('inbox-empty')).toHaveTextContent(
      messages.messaging.inbox.emptyRequests,
    );
  });
});

describe('PlayerCardView', () => {
  it('shows the name, the sports with levels, and Пиши — nothing more', () => {
    installFakeFetch(() => ok({}));
    wrap(
      <PlayerCardView
        card={{
          userId: 'u2',
          name: 'Мария',
          avatarUrl: null,
          sports: [{ sport: 'PADEL', level: 4 }],
        }}
      />,
    );
    const card = screen.getByTestId('player-card');
    expect(card).toHaveTextContent('Мария');
    expect(card).toHaveTextContent(`${messages.sports.PADEL} · Ниво 4`);
    expect(within(card).getByTestId('player-card-write')).toHaveTextContent(
      messages.messaging.start.write,
    );
    expect(card.textContent).not.toMatch(/@|\+359/);
  });
});

describe('ConversationView — block and report (#375)', () => {
  it('reports a message with a reason and the person’s words, through the report dialog', async () => {
    const seed = conversation({
      messages: [msg({ id: 'theirs' }), msg({ id: 'mine', mine: true })],
    });
    const calls = installFakeFetch((x) =>
      x.method === 'POST' && x.url.endsWith('/report') ? ok({ reported: true }, 201) : ok(seed),
    );
    wrap(<ConversationView side={ME} seed={seed} back={{ href: '/messages', label: c.back }} />);

    // Only the other side's line can be reported.
    const reportButtons = screen.getAllByTestId('conversation-report-message');
    expect(reportButtons).toHaveLength(1);
    fireEvent.click(reportButtons[0]!);

    const dialog = await screen.findByTestId('report-dialog');
    expect(screen.getByTestId('report-submit')).toBeDisabled();
    fireEvent.click(within(dialog).getByTestId('report-reason-abuse'));
    fireEvent.change(within(dialog).getByTestId('report-details'), {
      target: { value: 'Обижда ме' },
    });
    fireEvent.click(screen.getByTestId('report-submit'));

    expect(await screen.findByTestId('report-sent')).toHaveTextContent(
      messages.messaging.report.sent,
    );
    const sent = calls.find((x) => x.method === 'POST' && x.url.endsWith('/report'));
    expect(sent?.url).toBe('/api/v1/me/messages/theirs/report');
    expect(sent?.body).toEqual({ reason: 'abuse', details: 'Обижда ме' });
  });

  it('blocks at once, says so, and offers the way back', async () => {
    const seed = conversation();
    let blocked = false;
    const calls = installFakeFetch((x) => {
      if (x.url.endsWith('/block')) {
        blocked = x.method === 'POST';
        return ok({ blocked });
      }
      return ok(blocked ? { ...seed, state: 'blocked', blockedByMe: true, canSend: false } : seed);
    });
    wrap(<ConversationView side={ME} seed={seed} back={{ href: '/messages', label: c.back }} />);

    fireEvent.click(screen.getByTestId('conversation-block'));
    expect(await screen.findByTestId('conversation-notice-blockedByMe')).toBeInTheDocument();
    expect(screen.queryByTestId('conversation-composer')).not.toBeInTheDocument();
    expect(
      calls.some((x) => x.method === 'POST' && x.url.endsWith('/conversations/cv1/block')),
    ).toBe(true);

    fireEvent.click(screen.getByTestId('conversation-unblock'));
    await waitFor(() => expect(screen.getByTestId('conversation-composer')).toBeInTheDocument());
  });
});
