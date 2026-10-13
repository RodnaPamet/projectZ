import type { PrismaClient } from '@prisma/client';

import { leaveBooking } from '@/app-layer/usecases/booking-players';
import {
  blockConversation,
  getConversation,
  listConversations,
  sendMessage,
  unreadSummary,
} from '@/app-layer/usecases/messaging';
import { exportMyData } from '@/app-layer/usecases/data-export';
import { answerRequest, askToJoin, getBookingGame, openGame } from '@/app-layer/usecases/open-play';

import { prismaTestClient, seedAccount, seedTenant, seedVenue } from '../helpers/db';
import { asAppSuperuser } from '../helpers/rls';

/**
 * The game chat (#376, owner decision 2026-10-13, rule 3): a group chat of
 * the booker and everyone accepted. Made with the first accept; a player who
 * leaves the game before it is played leaves the chat; it stays open after.
 * And the P63 boundary underneath: a non-member, or a member who left, reads
 * nothing of it, and nobody changes their own membership.
 */
const db = prismaTestClient();
const HOUR = 3_600_000;

describe('the game chat (#376)', () => {
  /** As app_user, bound to a person, as messaging-rls.test.ts asks the policies. */
  function as<T>(userId: string, fn: (tx: PrismaClient) => Promise<T>): Promise<T> {
    return db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SELECT set_config('app.user_id', $1, true)`, userId);
      await tx.$executeRawUnsafe(`SET LOCAL ROLE app_user`);
      return fn(tx as unknown as PrismaClient);
    });
  }
  const counts = (tx: PrismaClient, conversationId: string) =>
    Promise.all([
      tx.conversation.count({ where: { id: conversationId } }),
      tx.chatMessage.count({ where: { conversationId } }),
    ]);

  async function setup() {
    const club = await seedTenant({}, db);
    const court = await seedVenue(club.tenantId, { name: 'Алфа Кортове' }, db);
    const [booker, a, b, stranger] = await Promise.all([
      seedAccount('PLAYER', db),
      seedAccount('PLAYER', db),
      seedAccount('PLAYER', db),
      seedAccount('PLAYER', db),
    ]);
    const start = new Date(Date.now() + 72 * HOUR);
    const booking = await asAppSuperuser(db, (tx) =>
      tx.booking.create({
        data: {
          tenantId: club.tenantId,
          resourceId: court.resourceId,
          startTs: start,
          endTs: new Date(start.getTime() + HOUR),
          bookedByUserId: booker,
          totalCents: 2400,
          status: 'CONFIRMED',
          idempotencyKey: `k-${Math.random()}`,
        },
        select: { id: true },
      }),
    );
    const view = await openGame({ userId: booker, bookingId: booking.id, spots: 2 });
    const gameId = view.game!.id;
    const join = async (userId: string) => {
      await askToJoin({ userId, gameId });
      const request = (await getBookingGame({
        userId: booker,
        bookingId: booking.id,
      }))!.requests.find((r) => r.player.userId === userId)!;
      return answerRequest({
        userId: booker,
        bookingId: booking.id,
        requestId: request.id,
        decision: 'accept',
      });
    };
    return { club, booker, a, b, stranger, bookingId: booking.id, gameId, join };
  }

  it('is made with the first accept, of the booker and the accepted, and shows in «Съобщения»', async () => {
    const s = await setup();
    expect((await getBookingGame({ userId: s.booker, bookingId: s.bookingId }))!.chatId).toBeNull();

    const afterA = await s.join(s.a);
    const chatId = afterA.chatId!;
    expect(chatId).toBeTruthy();
    expect((await getBookingGame({ userId: s.a, bookingId: s.bookingId }))!.chatId).toBe(chatId);

    // Before anybody writes, both see it, as a game.
    const inbox = await listConversations({ kind: 'player', userId: s.a });
    expect(inbox.items).toEqual([
      expect.objectContaining({
        id: chatId,
        kind: 'game',
        counterpart: expect.objectContaining({
          kind: 'game',
          venueName: 'Алфа Кортове',
          bookingId: s.bookingId,
          members: 2,
        }),
      }),
    ]);

    await s.join(s.b);
    const view = await getConversation({ kind: 'player', userId: s.b }, chatId);
    expect(view).toMatchObject({ kind: 'game', state: 'active', canSend: true });
    expect(view.counterpart).toMatchObject({ kind: 'game', members: 3 });

    // A message is news to every other member, bell and unread count.
    await sendMessage({ kind: 'player', userId: s.a }, chatId, 'Ще донеса топки');
    const bell = await asAppSuperuser(db, (tx) =>
      tx.notification.findMany({ where: { kind: 'MESSAGE_RECEIVED', refId: chatId } }),
    );
    expect(bell.map((n) => n.userId).sort()).toEqual([s.booker, s.b].sort());
    expect(await unreadSummary({ kind: 'player', userId: s.b })).toMatchObject({
      conversations: 1,
    });
    // Nobody blocks the game's chat for the rest.
    await expect(blockConversation({ kind: 'player', userId: s.b }, chatId)).rejects.toMatchObject({
      code: 'NOT_BLOCKABLE',
    });
  });

  it('a player who leaves the game leaves the chat, and reads it no more', async () => {
    const s = await setup();
    const { chatId } = await s.join(s.a);
    await s.join(s.b);
    await sendMessage({ kind: 'player', userId: s.b }, chatId!, 'Здравейте');

    await leaveBooking({ userId: s.b, bookingId: s.bookingId });

    await expect(getConversation({ kind: 'player', userId: s.b }, chatId!)).rejects.toMatchObject({
      code: 'CONVERSATION_NOT_FOUND',
    });
    expect((await listConversations({ kind: 'player', userId: s.b })).items).toEqual([]);
    expect(await as(s.b, (tx) => counts(tx, chatId!))).toEqual([0, 0]);
    // Their message stays in the others' history, under their name.
    const seen = await getConversation({ kind: 'player', userId: s.a }, chatId!);
    expect(seen.messages).toHaveLength(1);
    expect(seen.counterpart).toMatchObject({ members: 2 });
    // Nor is a message of theirs accepted any more.
    await expect(
      sendMessage({ kind: 'player', userId: s.b }, chatId!, 'Още съм тук?'),
    ).rejects.toMatchObject({ code: 'CONVERSATION_NOT_FOUND' });

    // Asking again and being accepted again brings them back.
    const back = await s.join(s.b);
    expect(back.chatId).toBe(chatId);
    expect((await getConversation({ kind: 'player', userId: s.b }, chatId!)).messages).toHaveLength(
      1,
    );
  });

  it('the policies: a member reads it, a stranger and a club bound to the booking do not', async () => {
    const s = await setup();
    const { chatId } = await s.join(s.a);
    await sendMessage({ kind: 'player', userId: s.booker }, chatId!, 'Добре дошла');

    expect(await as(s.a, (tx) => counts(tx, chatId!))).toEqual([1, 1]);
    expect(await as(s.booker, (tx) => counts(tx, chatId!))).toEqual([1, 1]);
    expect(await as(s.stranger, (tx) => counts(tx, chatId!))).toEqual([0, 0]);
    // The club's staff, acting for the club the game is at: still nothing.
    const staffView = await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SELECT set_config('app.user_id', $1, true)`, s.club.userId);
      await tx.$executeRawUnsafe(`SELECT set_config('app.tenant_id', $1, true)`, s.club.tenantId);
      await tx.$executeRawUnsafe(`SET LOCAL ROLE app_user`);
      return counts(tx as unknown as PrismaClient, chatId!);
    });
    expect(staffView).toEqual([0, 0]);
    // Nobody makes a game chat, or joins one, as themselves.
    await expect(
      as(s.stranger, (tx) =>
        tx.conversationParticipant.create({
          data: { conversationId: chatId!, userId: s.stranger, role: 'MEMBER' },
        }),
      ),
    ).rejects.toThrow();
    await expect(
      as(s.stranger, (tx) =>
        tx.conversation.create({
          data: { type: 'GROUP', createdById: s.stranger, pairKey: 'game:forged' },
        }),
      ),
    ).rejects.toThrow();
  });

  it('a member taken out cannot put themselves back (P63)', async () => {
    const s = await setup();
    const { chatId } = await s.join(s.a);
    await s.join(s.b);
    await leaveBooking({ userId: s.b, bookingId: s.bookingId });

    await expect(
      as(s.b, (tx) =>
        tx.conversationParticipant.updateMany({
          where: { conversationId: chatId!, userId: s.b },
          data: { leftAt: null },
        }),
      ),
    ).rejects.toThrow(/not changed by its members/);
    // Moving one's own read pointer is still theirs to do.
    const moved = await as(s.a, (tx) =>
      tx.conversationParticipant.updateMany({
        where: { conversationId: chatId!, userId: s.a },
        data: { lastReadAt: new Date() },
      }),
    );
    expect(moved.count).toBe(1);
  });

  it('the export lists the game chat by its venue', async () => {
    const s = await setup();
    const { chatId } = await s.join(s.a);
    await sendMessage({ kind: 'player', userId: s.a }, chatId!, 'Ще донеса топки');
    const exported = await exportMyData(s.a);
    expect(exported!.messages.conversations).toEqual([
      expect.objectContaining({
        with: { kind: 'game', name: 'Алфа Кортове', deletedAccount: false },
        messages: [expect.objectContaining({ mine: true, text: 'Ще донеса топки' })],
      }),
    ]);
  });
});
