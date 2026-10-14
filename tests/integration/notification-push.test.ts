import { deliver } from '@/app-layer/usecases/notification-outbox';
import { sendApns } from '@/lib/push/apns';

import { prismaTestClient, seedAccount } from '../helpers/db';
import { asAppSuperuser } from '../helpers/rls';

/**
 * THE PHONE RINGS ONCE PER NEW BELL ROW, IF THE PERSON WANTS THAT KIND (#529).
 *
 * The APNs sender is a stand-in that records what it was asked to send; the
 * bell row, the dedupe, the switches (P77) and the device rows are real.
 */
jest.mock('@/lib/push/apns', () => ({
  ...jest.requireActual('@/lib/push/apns'),
  sendApns: jest.fn(async () => ({ ok: true })),
}));
const mockApns = sendApns as jest.Mock;

describe('push on delivery', () => {
  const db = prismaTestClient();
  let userId: string;

  beforeEach(async () => {
    mockApns.mockClear();
    userId = await seedAccount('PLAYER', db);
    await asAppSuperuser(db, (tx) =>
      tx.deviceToken.create({
        data: {
          userId,
          deviceToken: `${userId}`.padEnd(64, '0').slice(0, 64),
          bundleId: 'bg.playerz.app',
          environment: 'SANDBOX',
        },
      }),
    );
  });

  const delivery = (over: Partial<Parameters<typeof deliver>[0]> = {}) => ({
    userId,
    kind: 'BOOKING_CONFIRMED' as const,
    dedupeKey: `push-test:${Math.random().toString(36).slice(2)}`,
    title: 'Резервацията е потвърдена',
    body: 'Корт 1, утре в 18:00',
    href: '/me/bookings/b1',
    refType: 'booking',
    refId: 'b1',
    email: {
      category: 'confirmation' as const,
      subject: 's',
      text: 't',
      locale: 'bg' as const,
    },
    ...over,
  });

  it('a new bell row pushes to the person’s device, with its words and its link', async () => {
    const d = delivery();
    expect(await deliver(d)).toMatchObject({ bell: true });

    expect(mockApns).toHaveBeenCalledTimes(1);
    const [device, payload] = mockApns.mock.calls[0];
    expect(device).toMatchObject({ bundleId: 'bg.playerz.app', environment: 'SANDBOX' });
    expect(payload).toMatchObject({
      title: 'Резервацията е потвърдена',
      body: 'Корт 1, утре в 18:00',
      url: '/me/bookings/b1',
      threadId: 'booking:b1',
    });
  });

  it('the same event twice writes one row and rings once', async () => {
    const d = delivery();
    await deliver(d);
    expect(await deliver(d)).toMatchObject({ bell: false });
    expect(mockApns).toHaveBeenCalledTimes(1);
  });

  it("the person's switch for that kind decides; the other kinds still ring", async () => {
    await asAppSuperuser(db, (tx) =>
      tx.user.update({ where: { id: userId }, data: { pushBookingConfirmations: false } }),
    );
    await deliver(delivery());
    expect(mockApns).not.toHaveBeenCalled();

    await deliver(
      delivery({
        kind: 'BOOKING_REMINDER',
        email: { category: 'reminder', subject: 's', text: 't', locale: 'bg' },
      }),
    );
    expect(mockApns).toHaveBeenCalledTimes(1);
  });

  it('`push: null` keeps it to the bell; a bell-only delivery names its kind to ring', async () => {
    await deliver(delivery({ push: null }));
    expect(mockApns).not.toHaveBeenCalled();

    await deliver(delivery({ email: null, push: 'clubChanges' }));
    expect(mockApns).toHaveBeenCalledTimes(1);
  });

  it('an answer about the account rings whatever the switches say', async () => {
    await asAppSuperuser(db, (tx) =>
      tx.user.update({
        where: { id: userId },
        data: {
          pushBookingConfirmations: false,
          pushBookingReminders: false,
          pushClubChanges: false,
          pushMessages: false,
          pushOpenPlay: false,
          pushLessonsTaught: false,
        },
      }),
    );
    await deliver(
      delivery({
        kind: 'COACH_PROFILE_APPROVED',
        email: { category: 'account', subject: 's', text: 't', locale: 'bg' },
      }),
    );
    expect(mockApns).toHaveBeenCalledTimes(1);
  });

  it('a failing sender costs the push, never the bell row', async () => {
    mockApns.mockRejectedValueOnce(new Error('socket hang up'));
    expect(await deliver(delivery())).toMatchObject({ bell: true });
  });
});
