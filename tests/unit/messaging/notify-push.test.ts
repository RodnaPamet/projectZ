/** @jest-environment node */

/**
 * A sent message is pushed (#481) to the sender's other tabs and every
 * recipient, on each person's own `notif:` channel, carrying the conversation
 * id and nothing else: the text never leaves Postgres this way.
 */
const broadcast = jest.fn(async (_channels: string[], _data: unknown) => ({
  delivered: true,
  degraded: false,
}));
jest.mock('@/lib/realtime/centrifugo', () => ({
  broadcast: (channels: string[], data: unknown) => broadcast(channels, data),
}));

const audience = jest.fn();
jest.mock('@/app-layer/usecases/messaging-directory', () => ({
  messageAudience: (...a: unknown[]) => audience(...a),
}));

const deliver = jest.fn(async () => undefined);
jest.mock('@/app-layer/usecases/notification-outbox', () => ({
  deliver: (...a: unknown[]) => deliver(...(a as [])),
}));

jest.mock('@/lib/i18n/server-messages', () => ({
  translateFor: async (_l: string, key: string) => key,
}));

import { notifyNewMessage } from '@/app-layer/usecases/messaging-notify';

const SENDER = 'csender000000000000000000';
const ANA = 'cana0000000000000000000000';
const STAFF = 'cstaff00000000000000000000';
const CONV = 'cconv00000000000000000000';

beforeEach(() => {
  broadcast.mockClear();
  deliver.mockClear();
  audience.mockReset().mockResolvedValue({
    type: 'CLUB',
    club: { tenantId: 't1', slug: 'levski', name: 'Левски' },
    request: false,
    senderName: 'Иван',
    fromClub: false,
    recipients: [
      { userId: ANA, locale: 'bg', side: 'player', lastReadAt: null },
      { userId: STAFF, locale: 'bg', side: 'club', lastReadAt: null },
    ],
  });
});

describe('notifyNewMessage pushes (#481)', () => {
  it("to the sender's and every recipient's own channel, with the conversation id only", async () => {
    await notifyNewMessage({ conversationId: CONV, messageId: 'cmsg', sender: { userId: SENDER } });

    expect(broadcast).toHaveBeenCalledTimes(1);
    const [channels, data] = broadcast.mock.calls[0];
    expect(channels).toEqual([`notif:${SENDER}`, `notif:${ANA}`, `notif:${STAFF}`]);
    expect(data).toEqual({ type: 'message', conversationId: CONV });
  });

  it('still rings the bell for every recipient', async () => {
    await notifyNewMessage({ conversationId: CONV, messageId: 'cmsg', sender: { userId: SENDER } });
    expect(deliver).toHaveBeenCalledTimes(2);
  });

  it('pushes nothing for a conversation with no audience', async () => {
    audience.mockResolvedValue(null);
    await notifyNewMessage({ conversationId: CONV, messageId: 'cmsg', sender: { userId: SENDER } });
    expect(broadcast).not.toHaveBeenCalled();
  });
});
