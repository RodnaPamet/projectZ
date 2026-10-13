import type { PrismaClient } from '@prisma/client';

import { leaveBooking } from '@/app-layer/usecases/booking-players';
import {
  blockConversation,
  getConversation,
  listConversations,
  reportMessage,
  sendMessage,
  unreadSummary,
} from '@/app-layer/usecases/messaging';
import { resolveChatCase } from '@/app-layer/usecases/moderation-messages';
import { listModerationCases } from '@/app-layer/usecases/moderation-queue';
import { reportGameNote } from '@/app-layer/usecases/open-play-report';
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

  it('a reported line reaches the moderation queue as a game chat, with the venue and the time (#512)', async () => {
    const s = await setup();
    const { chatId } = await s.join(s.a);
    await s.join(s.b);
    await sendMessage({ kind: 'player', userId: s.a }, chatId!, 'ти си никой');
    const rude = (await getConversation({ kind: 'player', userId: s.b }, chatId!)).messages[0]!.id;
    await reportMessage({ kind: 'player', userId: s.b }, rude, { reason: 'abuse' });

    const { items } = await asAppSuperuser(db, (tx) => listModerationCases(tx, {}));
    const item = items
      .flatMap((i) => (i.subject === 'REVIEW' ? [] : [i]))
      .find((i) => i.conversation.id === chatId)!;
    const booking = await asAppSuperuser(db, (tx) =>
      tx.booking.findUniqueOrThrow({
        where: { id: s.bookingId },
        select: { startTs: true, endTs: true },
      }),
    );
    expect(item.conversation).toMatchObject({
      kind: 'game',
      club: null,
      game: {
        venueName: 'Алфа Кортове',
        startTs: booking.startTs.toISOString(),
        endTs: booking.endTs.toISOString(),
        timezone: expect.any(String),
      },
    });
    expect(item.messages.map((m) => [m.body, m.reported])).toEqual([['ти си никой', true]]);
  });

  describe('reporting a game’s public note (#526)', () => {
    const NOTE = 'Само за сериозни играчи, без начинаещи!!!';
    const noteCases = async () =>
      (await asAppSuperuser(db, (tx) => listModerationCases(tx, {}))).items.flatMap((i) =>
        i.subject === 'OPEN_GAME_NOTE' ? [i] : [],
      );
    const noteOf = (gameId: string) =>
      asAppSuperuser(db, (tx) =>
        tx.openGame.findUniqueOrThrow({ where: { id: gameId }, select: { note: true } }),
      ).then((g) => g.note);

    async function gameWithNote() {
      const s = await setup();
      await asAppSuperuser(db, (tx) =>
        tx.openGame.update({ where: { id: s.gameId }, data: { note: NOTE } }),
      );
      return s;
    }

    it('joins the moderation queue as ONE case however many report it, with the note and no reporter', async () => {
      const s = await gameWithNote();
      await reportGameNote({
        userId: s.a,
        gameId: s.gameId,
        report: { reason: 'abuse', details: '<b>обижда</b> начинаещите' },
      });
      await reportGameNote({ userId: s.b, gameId: s.gameId, report: { reason: 'inappropriate' } });
      // The same person again: still one report of theirs.
      await reportGameNote({ userId: s.a, gameId: s.gameId, report: { reason: 'abuse' } });

      const cases = await noteCases();
      expect(cases).toHaveLength(1);
      const item = cases[0]!;
      expect(item).toMatchObject({
        subject: 'OPEN_GAME_NOTE',
        reason: 'user_report',
        conversation: {
          id: s.gameId,
          kind: 'game',
          game: { venueName: 'Алфа Кортове', timezone: expect.any(String) },
        },
      });
      expect(item.messages).toEqual([
        expect.objectContaining({ id: s.gameId, body: NOTE, reported: true, deleted: false }),
      ]);
      expect(item.reports.map((r) => r.reason)).toEqual([
        'abuse — обижда начинаещите',
        'inappropriate',
      ]);
      // What the moderator sees names neither reporter.
      const shown = JSON.stringify(item);
      expect(shown).not.toContain(s.a);
      expect(shown).not.toContain(s.b);
    });

    it('a moderator removes the note, and the game, its booking and its players stay', async () => {
      const s = await gameWithNote();
      await s.join(s.a);
      await reportGameNote({ userId: s.b, gameId: s.gameId, report: { reason: 'abuse' } });
      const [item] = await noteCases();
      const moderator = await seedAccount('PLAYER', db);

      const decided = await asAppSuperuser(db, (tx) =>
        resolveChatCase(tx, {
          caseId: item!.caseId,
          moderatorUserId: moderator,
          approve: false,
          note: 'insulting, removed per policy',
        }),
      );
      expect(decided).toMatchObject({ status: 'REJECTED', removed: 'note' });
      expect(await noteOf(s.gameId)).toBeNull();
      // The game is still there, with the player who joined it.
      const game = await getBookingGame({ userId: s.booker, bookingId: s.bookingId });
      expect(game).not.toBeNull();
      expect(game!.requests.filter((r) => r.status === 'ACCEPTED')).toHaveLength(1);
      expect(await noteCases()).toEqual([]);
    });

    it('a moderator keeps the note: nothing changes but the case', async () => {
      const s = await gameWithNote();
      await reportGameNote({ userId: s.a, gameId: s.gameId, report: { reason: 'other' } });
      const [item] = await noteCases();
      const moderator = await seedAccount('PLAYER', db);
      const decided = await asAppSuperuser(db, (tx) =>
        resolveChatCase(tx, { caseId: item!.caseId, moderatorUserId: moderator, approve: true }),
      );
      expect(decided).toMatchObject({ status: 'APPROVED', removed: null });
      expect(await noteOf(s.gameId)).toBe(NOTE);
    });

    it('not one’s own note, not a game without one, not an unknown game', async () => {
      const s = await gameWithNote();
      await expect(
        reportGameNote({ userId: s.booker, gameId: s.gameId, report: { reason: 'spam' } }),
      ).rejects.toMatchObject({ code: 'REPORT_OWN_NOTE' });
      await expect(
        reportGameNote({ userId: s.a, gameId: 'no-such-game', report: { reason: 'spam' } }),
      ).rejects.toMatchObject({ code: 'GAME_NOT_FOUND' });

      const bare = await setup();
      await expect(
        reportGameNote({ userId: bare.a, gameId: bare.gameId, report: { reason: 'spam' } }),
      ).rejects.toMatchObject({ code: 'GAME_NOTE_NOT_FOUND' });
      expect(await noteCases()).toEqual([]);
    });

    it('a club’s account cannot report: reporting is a player’s', async () => {
      const s = await gameWithNote();
      const staff = await seedAccount('CLUB', db);
      await expect(
        reportGameNote({ userId: staff, gameId: s.gameId, report: { reason: 'spam' } }),
      ).rejects.toMatchObject({ code: 'PLAYER_ACCOUNT_REQUIRED' });
    });

    it('the queue shows the note as it stands now, cleared by its writer included', async () => {
      const s = await gameWithNote();
      await reportGameNote({ userId: s.a, gameId: s.gameId, report: { reason: 'abuse' } });
      await asAppSuperuser(db, (tx) =>
        tx.openGame.update({ where: { id: s.gameId }, data: { note: null } }),
      );
      const [item] = await noteCases();
      expect(item!.messages).toEqual([
        expect.objectContaining({ body: null, deleted: true, reported: true }),
      ]);
    });
  });
});
