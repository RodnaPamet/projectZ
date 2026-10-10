import { deleteMyAccount } from '@/app-layer/usecases/account-deletion';
import { exportMyData } from '@/app-layer/usecases/data-export';
import {
  acceptRequest,
  blockConversation,
  declineRequest,
  findPlayers,
  getConversation,
  listConversations,
  markConversationRead,
  MAX_BODY_LENGTH,
  openClubConversation,
  openClubConversationWithPlayer,
  openCoPlayerConversation,
  openPlayerConversation,
  retractMessage,
  sendMessage,
  unblockConversation,
  unreadSummary,
  viewPlayerCard,
  type MessagingActor,
} from '@/app-layer/usecases/messaging';

import { prismaTestClient, seedAccount, seedTenant, seedVenue } from '../helpers/db';
import { asAppSuperuser } from '../helpers/rls';

/**
 * Messaging, module 1 (#375): the behaviour ported from Agrent's exchange
 * messaging, through the use case, against a real Postgres with the P54
 * policies on. The policies themselves are asked directly in
 * messaging-rls.test.ts.
 */
describe('messaging (#375)', () => {
  const db = prismaTestClient();
  const HOUR = 3_600_000;

  async function playerNamed(name: string, over: { searchable?: boolean } = {}) {
    const id = await seedAccount('PLAYER', db);
    await asAppSuperuser(db, (tx) =>
      tx.user.update({
        where: { id },
        data: { name, ...(over.searchable === false ? { searchable: false } : {}) },
      }),
    );
    return { kind: 'player', userId: id } as const satisfies MessagingActor;
  }

  /** A booking at a club with both players on it: they have played together. */
  async function playedTogether(a: string, b: string) {
    const club = await seedTenant({}, db);
    const { resourceId } = await seedVenue(club.tenantId, {}, db);
    await asAppSuperuser(db, async (tx) => {
      const startTs = new Date(Date.now() - 48 * HOUR - Math.floor(Math.random() * 1000) * HOUR);
      const booking = await tx.booking.create({
        data: {
          tenantId: club.tenantId,
          resourceId,
          startTs,
          endTs: new Date(startTs.getTime() + HOUR),
          status: 'COMPLETED',
          totalCents: 2400,
          bookedByUserId: a,
          idempotencyKey: `seed-${Math.random()}`,
        },
        select: { id: true },
      });
      await tx.bookingParticipant.create({
        data: { tenantId: club.tenantId, bookingId: booking.id, userId: b, position: 1 },
      });
    });
    return club;
  }

  async function staffOf(tenantId: string, role: 'MANAGER' | 'STAFF', name: string) {
    const id = await seedAccount('CLUB', db);
    await asAppSuperuser(db, async (tx) => {
      await tx.user.update({ where: { id }, data: { name } });
      await tx.tenantMembership.create({
        data: { tenantId, userId: id, role, status: 'ACTIVE' },
      });
    });
    return id;
  }

  // ── Opening ────────────────────────────────────────────────────────────

  it('opening is idempotent, and two racing opens get ONE conversation (agri-saas #1418)', async () => {
    const a = await playerNamed('Ана');
    const b = await playerNamed('Борис');

    const [x, y] = await Promise.all([
      openPlayerConversation(a, b.userId),
      openPlayerConversation(b, a.userId),
    ]);
    expect(x.id).toBe(y.id);
    expect([x.created, y.created].filter(Boolean)).toHaveLength(1);

    const again = await openPlayerConversation(a, b.userId);
    expect(again).toEqual({ id: x.id, created: false });
  });

  it('nobody writes to themselves, and a club account is not a player here', async () => {
    const a = await playerNamed('Ана');
    await expect(openPlayerConversation(a, a.userId)).rejects.toMatchObject({
      code: 'CANNOT_MESSAGE_SELF',
    });
    const club = await seedTenant({}, db);
    await expect(
      openPlayerConversation({ kind: 'player', userId: club.userId }, a.userId),
    ).rejects.toMatchObject({ code: 'PLAYER_ACCOUNT_REQUIRED' });
  });

  // ── Requests ───────────────────────────────────────────────────────────

  it('a STRANGER gets one message, as a request in «Заявки», until it is accepted', async () => {
    const a = await playerNamed('Ана');
    const b = await playerNamed('Борис');
    const { id } = await openPlayerConversation(a, b.userId);

    await sendMessage(a, id, 'Здравейте, играете ли падел?');
    await expect(sendMessage(a, id, 'Ехо?')).rejects.toMatchObject({ code: 'REQUEST_PENDING' });

    // Theirs: in «Заявки», not in the conversations.
    expect((await listConversations(b, { tab: 'requests' })).items.map((c) => c.id)).toEqual([id]);
    expect((await listConversations(b)).items).toHaveLength(0);
    expect((await getConversation(b, id)).state).toBe('request');
    // Mine: in my conversations, waiting.
    const mine = await getConversation(a, id);
    expect(mine.state).toBe('pending');
    expect(mine.canSend).toBe(false);

    await acceptRequest(b, id);
    await sendMessage(a, id, 'Чудесно!');
    expect((await getConversation(a, id)).state).toBe('active');
    expect((await listConversations(b)).items.map((c) => c.id)).toEqual([id]);
  });

  it('declining ends a request QUIETLY: the sender sees it waiting, and cannot write again', async () => {
    const a = await playerNamed('Ана');
    const b = await playerNamed('Борис');
    const { id } = await openPlayerConversation(a, b.userId);
    await sendMessage(a, id, 'Здравейте');

    await declineRequest(b, id);

    expect((await listConversations(b, { tab: 'requests' })).items).toHaveLength(0);
    expect((await listConversations(b)).items).toHaveLength(0);
    const theirs = await getConversation(a, id);
    expect(theirs.state).toBe('pending');
    expect(theirs.canSend).toBe(false);
    await expect(sendMessage(a, id, 'Пак аз')).rejects.toMatchObject({ code: 'REQUEST_PENDING' });

    // The decliner may change their mind by answering; that accepts it.
    await sendMessage(b, id, 'Всъщност, да.');
    expect((await getConversation(a, id)).state).toBe('active');
  });

  it('answering a request accepts it', async () => {
    const a = await playerNamed('Ана');
    const b = await playerNamed('Борис');
    const { id } = await openPlayerConversation(a, b.userId);
    await sendMessage(a, id, 'Здравейте');
    await sendMessage(b, id, 'Здрасти!');
    await sendMessage(a, id, 'Утре в 18?');
    expect((await getConversation(b, id)).state).toBe('active');
  });

  it('somebody you have played with is not a stranger: no request', async () => {
    const a = await playerNamed('Ана');
    const b = await playerNamed('Борис');
    await playedTogether(a.userId, b.userId);

    const { id } = await openPlayerConversation(a, b.userId);
    await sendMessage(a, id, 'Пак ли утре?');
    await sendMessage(a, id, 'Аз съм навън до 18.');
    expect((await listConversations(b)).items.map((c) => c.id)).toEqual([id]);
    expect((await getConversation(b, id)).state).toBe('active');
  });

  it('"Пиши" on a booking opens the conversation by the place on it, never by an id', async () => {
    const a = await playerNamed('Ана');
    const b = await playerNamed('Борис', { searchable: false });
    const stranger = await playerNamed('Непознат');
    await playedTogether(a.userId, b.userId);
    const { bookingId, participantId } = await asAppSuperuser(db, async (tx) => {
      const p = await tx.bookingParticipant.findFirstOrThrow({ where: { userId: b.userId } });
      return { bookingId: p.bookingId, participantId: p.id };
    });

    // The booker writes to the added player, who is hidden from search.
    const { id } = await openCoPlayerConversation(a, bookingId, participantId);
    // …and the added player to the booker (participantId null), the same one.
    expect((await openCoPlayerConversation(b, bookingId, null)).id).toBe(id);
    await sendMessage(b, id, 'Добра игра!');
    expect((await getConversation(a, id)).state).toBe('active');

    // Somebody not on the booking learns nothing from it.
    await expect(
      openCoPlayerConversation(stranger, bookingId, participantId),
    ).rejects.toMatchObject({
      code: 'PLAYER_NOT_FOUND',
    });
    // And nobody writes to their own place.
    await expect(openCoPlayerConversation(b, bookingId, participantId)).rejects.toMatchObject({
      code: 'PLAYER_NOT_FOUND',
    });
  });

  // ── Search and the card ────────────────────────────────────────────────

  it('search finds players by name, never the hidden, the blocked, a club or the caller', async () => {
    const me = await playerNamed('Мария Иванова');
    const shown = await playerNamed('Иван Петров');
    await playerNamed('Иван Скрит', { searchable: false });
    const blocker = await playerNamed('Иван Блокирал');
    const club = await seedTenant({}, db);
    await asAppSuperuser(db, (tx) =>
      tx.user.update({ where: { id: club.userId }, data: { name: 'Иван Клуб' } }),
    );
    await asAppSuperuser(db, (tx) =>
      tx.userBlock.create({ data: { blockerId: blocker.userId, blockedId: me.userId } }),
    );
    await asAppSuperuser(db, (tx) =>
      tx.playerSportLevel.create({ data: { userId: shown.userId, sport: 'PADEL', level: 4 } }),
    );

    const found = await findPlayers(me, 'иван');
    expect(found.map((p) => p.userId)).toEqual([shown.userId]);
    // The public card and nothing else: no email, no phone.
    expect(found[0]).toEqual({
      userId: shown.userId,
      name: 'Иван Петров',
      avatarUrl: null,
      sports: [{ sport: 'PADEL', level: 4 }],
    });
    expect(await findPlayers(me, 'и')).toEqual([]);
  });

  it('a HIDDEN player can be written to by people they played with, and by nobody else', async () => {
    const hidden = await playerNamed('Скрит', { searchable: false });
    const stranger = await playerNamed('Непознат');
    const partner = await playerNamed('Партньор');
    await playedTogether(hidden.userId, partner.userId);

    await expect(openPlayerConversation(stranger, hidden.userId)).rejects.toMatchObject({
      code: 'PLAYER_NOT_FOUND',
    });
    await expect(viewPlayerCard(stranger, hidden.userId)).rejects.toMatchObject({
      code: 'PLAYER_NOT_FOUND',
    });
    const { id } = await openPlayerConversation(partner, hidden.userId);
    expect(id).toBeTruthy();
    expect((await viewPlayerCard(partner, hidden.userId)).name).toBe('Скрит');

    // …and a conversation that already exists stays reachable after they hide.
    const later = await playerNamed('По-късно');
    const { id: before } = await openPlayerConversation(later, partner.userId);
    await asAppSuperuser(db, (tx) =>
      tx.user.update({ where: { id: partner.userId }, data: { searchable: false } }),
    );
    expect((await openPlayerConversation(later, partner.userId)).id).toBe(before);
  });

  // ── Sending ────────────────────────────────────────────────────────────

  it('a body is sanitised, measured after sanitising, and stored as ciphertext both sides can read', async () => {
    const a = await playerNamed('Ана');
    const b = await playerNamed('Борис');
    await playedTogether(a.userId, b.userId);
    const { id } = await openPlayerConversation(a, b.userId);

    const sent = await sendMessage(a, id, '<b>Здравей</b> <script>alert(1)</script>Борис');
    const stored = await asAppSuperuser(db, (tx) =>
      tx.chatMessage.findUniqueOrThrow({ where: { id: sent.id }, select: { body: true } }),
    );
    expect(stored.body.startsWith('v1:')).toBe(true);
    expect(stored.body).not.toContain('Здравей');

    const theirs = await getConversation(b, id);
    expect(theirs.messages.map((m) => m.body)).toEqual(['Здравей Борис']);
    expect(theirs.messages[0]).toMatchObject({
      mine: false,
      fromClub: false,
      sender: { name: 'Ана', deleted: false, clubName: null },
    });

    await expect(sendMessage(a, id, 'x'.repeat(MAX_BODY_LENGTH + 1))).rejects.toMatchObject({
      code: 'MESSAGE_TOO_LONG',
    });
    await expect(sendMessage(a, id, `${'x'.repeat(MAX_BODY_LENGTH)}<i></i>`)).resolves.toBeTruthy();
    await expect(sendMessage(a, id, '<p> </p>')).rejects.toMatchObject({ code: 'MESSAGE_EMPTY' });
  });

  it('an Idempotency-Key makes a retried send say it once, even when the retries race', async () => {
    const a = await playerNamed('Ана');
    const b = await playerNamed('Борис');
    await playedTogether(a.userId, b.userId);
    const { id } = await openPlayerConversation(a, b.userId);

    const first = await sendMessage(a, id, 'Веднъж', 'key-1');
    const retry = await sendMessage(a, id, 'Веднъж', 'key-1');
    expect(retry).toMatchObject({ id: first.id, replayed: true });

    const raced = await Promise.all([
      sendMessage(a, id, 'Два пъти?', 'key-2'),
      sendMessage(a, id, 'Два пъти?', 'key-2'),
    ]);
    expect(raced[0].id).toBe(raced[1].id);
    expect((await getConversation(b, id)).messages).toHaveLength(2);
  });

  it('the read pointer only moves forward, and your own message is never unread', async () => {
    const a = await playerNamed('Ана');
    const b = await playerNamed('Борис');
    await playedTogether(a.userId, b.userId);
    const { id } = await openPlayerConversation(a, b.userId);

    await sendMessage(a, id, 'едно');
    await sendMessage(a, id, 'две');
    expect((await getConversation(a, id)).unreadCount).toBe(0);
    expect((await getConversation(b, id)).unreadCount).toBe(2);
    expect(await unreadSummary(b)).toEqual({ conversations: 1, requests: 0 });

    const { readAt } = await markConversationRead(b, id);
    // A late answer from a second tab, carrying an older moment, changes nothing.
    await asAppSuperuser(db, (tx) =>
      tx.conversationParticipant.updateMany({
        where: { conversationId: id, userId: b.userId, lastReadAt: { lt: new Date(0) } },
        data: { lastReadAt: new Date(0) },
      }),
    );
    const row = await asAppSuperuser(db, (tx) =>
      tx.conversationParticipant.findUniqueOrThrow({
        where: { conversationId_userId: { conversationId: id, userId: b.userId } },
      }),
    );
    expect(row.lastReadAt?.getTime()).toBe(readAt.getTime());
    expect((await getConversation(b, id)).unreadCount).toBe(0);
    expect(await unreadSummary(b)).toEqual({ conversations: 0, requests: 0 });
  });

  it('a retraction leaves a tombstone and no text, and only the sender may retract', async () => {
    const a = await playerNamed('Ана');
    const b = await playerNamed('Борис');
    await playedTogether(a.userId, b.userId);
    const { id } = await openPlayerConversation(a, b.userId);
    const m = await sendMessage(a, id, 'Грешка');

    await expect(retractMessage(b, m.id)).rejects.toMatchObject({ code: 'MESSAGE_NOT_SENDER' });
    await retractMessage(a, m.id);
    await retractMessage(a, m.id);

    const theirs = await getConversation(b, id);
    expect(theirs.messages).toEqual([
      expect.objectContaining({ id: m.id, body: null, deleted: true }),
    ]);
    const stored = await asAppSuperuser(db, (tx) =>
      tx.chatMessage.findUniqueOrThrow({ where: { id: m.id } }),
    );
    expect(stored.body).toBe('');
  });

  it('pages are keyset pages: nothing repeats or goes missing across a boundary of equal times', async () => {
    const a = await playerNamed('Ана');
    const b = await playerNamed('Борис');
    await playedTogether(a.userId, b.userId);
    const { id } = await openPlayerConversation(a, b.userId);
    // 60 messages, all at ONE instant: only the id orders them.
    const at = new Date('2026-10-01T10:00:00Z');
    await asAppSuperuser(db, (tx) =>
      tx.chatMessage.createMany({
        data: Array.from({ length: 60 }, () => ({
          conversationId: id,
          senderId: a.userId,
          body: '',
          deletedAt: at,
          createdAt: at,
        })),
      }),
    );
    const first = await getConversation(b, id);
    expect(first.messages).toHaveLength(50);
    expect(first.olderCursor).not.toBeNull();
    const second = await getConversation(b, id, { before: first.olderCursor });
    expect(second.messages).toHaveLength(10);
    expect(second.olderCursor).toBeNull();
    const all = new Set([...first.messages, ...second.messages].map((m) => m.id));
    expect(all.size).toBe(60);
  });

  // ── Block ──────────────────────────────────────────────────────────────

  it('a block stops new messages BOTH ways, hides the conversation from the blocked, and lifts', async () => {
    const a = await playerNamed('Ана');
    const b = await playerNamed('Борис');
    await playedTogether(a.userId, b.userId);
    const { id } = await openPlayerConversation(a, b.userId);
    await sendMessage(b, id, 'Здрасти');

    await blockConversation(a, id);
    await blockConversation(a, id);

    // The blocker keeps the history and is told why they cannot write.
    const mine = await getConversation(a, id);
    expect(mine).toMatchObject({ state: 'blocked', blockedByMe: true, canSend: false });
    await expect(sendMessage(a, id, 'хм')).rejects.toMatchObject({ code: 'CONVERSATION_BLOCKED' });
    // The blocked person learns nothing: the conversation is simply not there.
    await expect(getConversation(b, id)).rejects.toMatchObject({ code: 'CONVERSATION_NOT_FOUND' });
    await expect(sendMessage(b, id, 'ехо')).rejects.toMatchObject({
      code: 'CONVERSATION_NOT_FOUND',
    });
    expect((await listConversations(b)).items).toHaveLength(0);
    await expect(openPlayerConversation(b, a.userId)).rejects.toMatchObject({
      code: 'PLAYER_NOT_FOUND',
    });

    await unblockConversation(a, id);
    await sendMessage(b, id, 'Пак здравей');
    expect((await getConversation(a, id)).state).toBe('active');
  });

  // ── The club ───────────────────────────────────────────────────────────

  it('a player writes to a club; EVERY staff member reads one inbox, and each reply names its writer', async () => {
    const club = await seedTenant({ name: 'Тенис клуб Левски' }, db);
    const ivan = await staffOf(club.tenantId, 'STAFF', 'Иван');
    const maria = await staffOf(club.tenantId, 'MANAGER', 'Мария');
    const owner: MessagingActor = { kind: 'club', userId: club.userId, tenantId: club.tenantId };
    const asIvan: MessagingActor = { kind: 'club', userId: ivan, tenantId: club.tenantId };
    const asMaria: MessagingActor = { kind: 'club', userId: maria, tenantId: club.tenantId };
    const p = await playerNamed('Петър');

    const { id } = await openClubConversation(p, club.tenantSlug);
    await sendMessage(p, id, 'Имате ли свободен корт утре?');

    for (const staff of [owner, asIvan, asMaria]) {
      const inbox = await listConversations(staff);
      expect(inbox.items.map((c) => c.id)).toEqual([id]);
      expect(inbox.items[0]).toMatchObject({
        unreadCount: 1,
        counterpart: { kind: 'player', name: 'Петър' },
      });
    }

    await sendMessage(asIvan, id, 'Да, от 18:00.');
    // Ivan's own pointer moved, Maria's did not: unread is per person.
    expect((await getConversation(asIvan, id)).unreadCount).toBe(0);
    expect((await getConversation(asMaria, id)).unreadCount).toBe(1);

    const theirs = await getConversation(p, id);
    expect(theirs.counterpart).toMatchObject({ kind: 'club', name: 'Тенис клуб Левски' });
    expect(theirs.messages.at(-1)).toMatchObject({
      fromClub: true,
      mine: false,
      sender: { name: 'Иван', clubName: 'Тенис клуб Левски' },
    });
    const colleagues = await getConversation(asMaria, id);
    expect(colleagues.messages.at(-1)).toMatchObject({ fromClub: true, mine: false });
  });

  it('another club, and a player bound to this club, never see this club’s conversations', async () => {
    const club = await seedTenant({}, db);
    const other = await seedTenant({}, db);
    const p = await playerNamed('Петър');
    const q = await playerNamed('Квинт');
    const { id } = await openClubConversation(p, club.tenantSlug);
    await sendMessage(p, id, 'Здравейте');

    const otherStaff: MessagingActor = {
      kind: 'club',
      userId: other.userId,
      tenantId: other.tenantId,
    };
    await expect(getConversation(otherStaff, id)).rejects.toMatchObject({
      code: 'CONVERSATION_NOT_FOUND',
    });
    expect((await listConversations(otherStaff)).items).toHaveLength(0);

    // A player is not staff because their request is bound to the club.
    const posing: MessagingActor = { kind: 'club', userId: q.userId, tenantId: club.tenantId };
    expect((await listConversations(posing)).items).toHaveLength(0);
    await expect(getConversation(posing, id)).rejects.toMatchObject({
      code: 'CONVERSATION_NOT_FOUND',
    });
    await expect(getConversation(q, id)).rejects.toMatchObject({ code: 'CONVERSATION_NOT_FOUND' });
  });

  it('a club starts a conversation only with a player on its Играчи list', async () => {
    const club = await seedTenant({}, db);
    const staff: MessagingActor = { kind: 'club', userId: club.userId, tenantId: club.tenantId };
    const stranger = await playerNamed('Непознат');
    const regular = await playerNamed('Редовен');
    await asAppSuperuser(db, (tx) =>
      tx.tenantMembership.create({
        data: { tenantId: club.tenantId, userId: regular.userId, role: 'PLAYER', status: 'ACTIVE' },
      }),
    );

    await expect(openClubConversationWithPlayer(staff, stranger.userId)).rejects.toMatchObject({
      code: 'NOT_A_CLUB_PLAYER',
    });
    const { id, created } = await openClubConversationWithPlayer(staff, regular.userId);
    expect(created).toBe(true);
    await sendMessage(staff, id, 'Напомняме за турнира в събота.');
    // The player's own "Пиши на клуба" lands in the same conversation.
    expect((await openClubConversation(regular, club.tenantSlug)).id).toBe(id);
    expect((await listConversations(regular)).items[0]).toMatchObject({
      id,
      counterpart: { kind: 'club', slug: club.tenantSlug },
      unreadCount: 1,
    });
  });

  it('a club conversation blocked by one side stops both, and only that side lifts it', async () => {
    const club = await seedTenant({}, db);
    const staff: MessagingActor = { kind: 'club', userId: club.userId, tenantId: club.tenantId };
    const p = await playerNamed('Петър');
    const { id } = await openClubConversation(p, club.tenantSlug);
    await sendMessage(p, id, 'Здравейте');

    await blockConversation(p, id);
    expect(await getConversation(p, id)).toMatchObject({ state: 'blocked', blockedByMe: true });
    expect(await getConversation(staff, id)).toMatchObject({
      state: 'blocked',
      blockedByMe: false,
    });
    await expect(sendMessage(staff, id, 'Ало')).rejects.toMatchObject({
      code: 'CONVERSATION_BLOCKED',
    });
    await expect(unblockConversation(staff, id)).rejects.toMatchObject({
      code: 'BLOCKED_BY_OTHER_SIDE',
    });
    await unblockConversation(p, id);
    await sendMessage(staff, id, 'Ало');
  });

  // ── Account deletion (#370) ────────────────────────────────────────────

  it('a deleted person’s messages show as «Изтрит потребител», with their text gone; the other side’s stay', async () => {
    const a = await playerNamed('Ана');
    const b = await playerNamed('Борис');
    await playedTogether(a.userId, b.userId);
    const { id } = await openPlayerConversation(a, b.userId);
    const mine = await sendMessage(a, id, 'Моята реплика');
    await sendMessage(b, id, 'Отговор');

    await deleteMyAccount(a.userId);

    const view = await getConversation(b, id);
    expect(view.counterpart).toMatchObject({ kind: 'player', name: null, deleted: true });
    expect(view).toMatchObject({ state: 'closed', canSend: false });
    expect(view.messages).toEqual([
      expect.objectContaining({
        id: mine.id,
        body: null,
        deleted: true,
        sender: { name: null, deleted: true, clubName: null },
      }),
      expect.objectContaining({ body: 'Отговор', mine: true }),
    ]);
    const stored = await asAppSuperuser(db, (tx) =>
      tx.chatMessage.findUniqueOrThrow({ where: { id: mine.id } }),
    );
    expect(stored.body).toBe('');
    await expect(sendMessage(b, id, 'Ехо?')).rejects.toMatchObject({ code: 'RECIPIENT_GONE' });
  });

  it('the data export carries the person’s conversations, both voices, and who they blocked', async () => {
    const a = await playerNamed('Ана');
    const b = await playerNamed('Борис');
    const c = await playerNamed('Цвета');
    await playedTogether(a.userId, b.userId);
    const { id } = await openPlayerConversation(a, b.userId);
    await sendMessage(a, id, 'Утре?');
    const gone = await sendMessage(b, id, 'Не мога');
    await retractMessage(b, gone.id);
    await sendMessage(b, id, 'Може в петък');
    const { id: withC } = await openPlayerConversation(a, c.userId);
    await blockConversation(a, withC);

    const file = await exportMyData(a.userId);
    expect(file?.messages.shownInPlayerSearch).toBe(true);
    expect(file?.messages.blocked).toEqual([{ name: 'Цвета', at: expect.any(String) }]);
    const conv = file?.messages.conversations.find((x) => x.with.name === 'Борис');
    expect(conv?.messages.map((m) => [m.mine, m.text, m.retracted])).toEqual([
      [true, 'Утре?', false],
      [false, null, true],
      [false, 'Може в петък', false],
    ]);
  });

  // ── Notify after commit ────────────────────────────────────────────────

  it('the bell rings after the message committed — once per unread stretch — and never for a refused send', async () => {
    const a = await playerNamed('Ана');
    const b = await playerNamed('Борис');
    const { id } = await openPlayerConversation(a, b.userId);
    await sendMessage(a, id, 'Здравейте');
    // Refused (one message per request): no message, so no bell either.
    await expect(sendMessage(a, id, 'Ехо')).rejects.toMatchObject({ code: 'REQUEST_PENDING' });

    const bells = () =>
      asAppSuperuser(db, (tx) =>
        tx.notification.findMany({
          where: { userId: b.userId, refType: 'conversation', refId: id },
          orderBy: { createdAt: 'asc' },
          take: 10,
        }),
      );
    expect(await bells()).toEqual([
      expect.objectContaining({
        kind: 'MESSAGE_RECEIVED',
        title: 'Ана иска да ви пише',
        href: `/messages/${id}`,
        readAt: null,
      }),
    ]);

    await acceptRequest(b, id);
    // Reading the conversation read its bell.
    expect((await bells())[0]!.readAt).not.toBeNull();
    await sendMessage(a, id, 'Едно');
    await sendMessage(a, id, 'Две');
    expect(await bells()).toHaveLength(2);
  });

  it('a player’s message to a club rings every staff member, and a reply rings the player', async () => {
    const club = await seedTenant({ name: 'Падел Център' }, db);
    const ivan = await staffOf(club.tenantId, 'STAFF', 'Иван');
    const p = await playerNamed('Петър');
    const { id } = await openClubConversation(p, club.tenantSlug);
    await sendMessage(p, id, 'Здравейте');

    const rows = await asAppSuperuser(db, (tx) =>
      tx.notification.findMany({
        where: { refType: 'conversation', refId: id },
        select: { userId: true, href: true },
        take: 10,
      }),
    );
    expect(rows.map((r) => r.userId).sort()).toEqual([club.userId, ivan].sort());
    expect(rows[0]!.href).toBe(`/t/${club.tenantSlug}/admin/messages/${id}`);

    await sendMessage({ kind: 'club', userId: ivan, tenantId: club.tenantId }, id, 'Добър ден');
    const toPlayer = await asAppSuperuser(db, (tx) =>
      tx.notification.findFirstOrThrow({ where: { userId: p.userId, refId: id } }),
    );
    expect(toPlayer).toMatchObject({ title: 'Падел Център ви писа', body: 'Иван · Падел Център' });
  });
});
