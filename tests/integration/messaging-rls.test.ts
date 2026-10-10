import type { PrismaClient } from '@prisma/client';

import {
  openClubConversation,
  openClubConversationWithPlayer,
  openPlayerConversation,
  sendMessage,
} from '@/app-layer/usecases/messaging';

import { prismaTestClient, seedAccount, seedTenant } from '../helpers/db';
import { asAppSuperuser } from '../helpers/rls';

/**
 * The P54 policies, asked DIRECTLY (#375): what a session bound as app_user
 * sees of the messaging tables, with no use case in front of it. The use case
 * checks which side is asking; these policies are the boundary, so they are
 * what a forgotten `where` would fall back on.
 *
 *   - one person never reads another's conversation, message or read pointer;
 *   - a club's staff read their club's conversations, and no other club's;
 *   - being BOUND to a club's tenant (as a player's booking is) is not staff;
 *   - a staff member who leaves the club loses the inbox with the membership;
 *   - nobody writes a message as somebody else, or a plaintext body;
 *   - who blocked whom is visible to those two people only.
 */
describe('messaging RLS (P54)', () => {
  const db = prismaTestClient();

  /** As app_user, bound to a person and optionally a club. */
  function as<T>(
    who: { userId: string; tenantId?: string },
    fn: (tx: PrismaClient) => Promise<T>,
  ): Promise<T> {
    return db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SELECT set_config('app.user_id', $1, true)`, who.userId);
      if (who.tenantId) {
        await tx.$executeRawUnsafe(`SELECT set_config('app.tenant_id', $1, true)`, who.tenantId);
      }
      await tx.$executeRawUnsafe(`SET LOCAL ROLE app_user`);
      return fn(tx as unknown as PrismaClient);
    });
  }

  const counts = (tx: PrismaClient, conversationId: string) =>
    Promise.all([
      tx.conversation.count({ where: { id: conversationId } }),
      tx.chatMessage.count({ where: { conversationId } }),
      tx.conversationParticipant.count({ where: { conversationId } }),
    ]);

  async function player() {
    return seedAccount('PLAYER', db);
  }

  it('a DM is readable by its two players and by nobody else', async () => {
    const [a, b, c] = await Promise.all([player(), player(), player()]);
    const { id } = await openPlayerConversation({ kind: 'player', userId: a }, b);
    await sendMessage({ kind: 'player', userId: a }, id, 'Здравейте');

    expect(await as({ userId: a }, (tx) => counts(tx, id))).toEqual([1, 1, 2]);
    expect(await as({ userId: b }, (tx) => counts(tx, id))).toEqual([1, 1, 2]);
    expect(await as({ userId: c }, (tx) => counts(tx, id))).toEqual([0, 0, 0]);
    // P15's policy read a NULL tenant as "anyone": no person bound sees nothing.
    const unbound = await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL ROLE app_user`);
      return counts(tx as unknown as PrismaClient, id);
    });
    expect(unbound).toEqual([0, 0, 0]);
  });

  it('a club conversation: the player and the club’s staff, not another club, not a player bound to the club', async () => {
    const club = await seedTenant({}, db);
    const other = await seedTenant({}, db);
    const [p, q] = await Promise.all([player(), player()]);
    const { id } = await openClubConversation({ kind: 'player', userId: p }, club.tenantSlug);
    await sendMessage({ kind: 'player', userId: p }, id, 'Здравейте');

    expect(await as({ userId: p }, (tx) => counts(tx, id))).toEqual([1, 1, 1]);
    expect(
      await as({ userId: club.userId, tenantId: club.tenantId }, (tx) => counts(tx, id)),
    ).toEqual([1, 1, 1]);
    // Staff, but of another club — and bound to either club.
    expect(
      await as({ userId: other.userId, tenantId: other.tenantId }, (tx) => counts(tx, id)),
    ).toEqual([0, 0, 0]);
    expect(
      await as({ userId: other.userId, tenantId: club.tenantId }, (tx) => counts(tx, id)),
    ).toEqual([0, 0, 0]);
    // Staff of THIS club, but not acting for it (no tenant bound).
    expect(await as({ userId: club.userId }, (tx) => counts(tx, id))).toEqual([0, 0, 0]);
    // A player whose request is bound to the club, as a booking's is.
    expect(await as({ userId: q, tenantId: club.tenantId }, (tx) => counts(tx, id))).toEqual([
      0, 0, 0,
    ]);
  });

  it('a staff member who leaves the club loses the inbox, whatever read pointer they kept', async () => {
    const club = await seedTenant({}, db);
    const staff = await seedAccount('CLUB', db);
    const membership = await asAppSuperuser(db, (tx) =>
      tx.tenantMembership.create({
        data: { tenantId: club.tenantId, userId: staff, role: 'STAFF', status: 'ACTIVE' },
        select: { id: true },
      }),
    );
    const p = await player();
    const { id } = await openClubConversation({ kind: 'player', userId: p }, club.tenantSlug);
    await sendMessage({ kind: 'club', userId: staff, tenantId: club.tenantId }, id, 'Добър ден');
    expect((await as({ userId: staff, tenantId: club.tenantId }, (tx) => counts(tx, id)))[0]).toBe(
      1,
    );

    await asAppSuperuser(db, (tx) =>
      tx.tenantMembership.update({ where: { id: membership.id }, data: { status: 'SUSPENDED' } }),
    );
    expect(await as({ userId: staff, tenantId: club.tenantId }, (tx) => counts(tx, id))).toEqual([
      0, 0, 1,
    ]);
  });

  it('nobody writes a message as somebody else, into a conversation they cannot read, or in plaintext', async () => {
    const [a, b, c] = await Promise.all([player(), player(), player()]);
    const { id } = await openPlayerConversation({ kind: 'player', userId: a }, b);

    await expect(
      as({ userId: a }, (tx) =>
        tx.chatMessage.createMany({ data: [{ conversationId: id, senderId: b, body: '' }] }),
      ),
    ).rejects.toThrow(/row-level security/);
    await expect(
      as({ userId: c }, (tx) =>
        tx.chatMessage.createMany({ data: [{ conversationId: id, senderId: c, body: '' }] }),
      ),
    ).rejects.toThrow(/row-level security/);
    await expect(
      as({ userId: a }, (tx) =>
        tx.chatMessage.createMany({
          data: [{ conversationId: id, senderId: a, body: 'не е шифровано' }],
        }),
      ),
    ).rejects.toThrow(/chat_message_body_is_envelope/);
    // …and a player does not write "for a club".
    const club = await seedTenant({}, db);
    await expect(
      as({ userId: a, tenantId: club.tenantId }, (tx) =>
        tx.chatMessage.createMany({
          data: [{ conversationId: id, senderId: a, senderTenantId: club.tenantId, body: '' }],
        }),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it('a person moves only their own read pointer, and a conversation’s identity never changes', async () => {
    const [a, b] = await Promise.all([player(), player()]);
    const { id } = await openPlayerConversation({ kind: 'player', userId: a }, b);

    const moved = await as({ userId: a }, (tx) =>
      tx.conversationParticipant.updateMany({
        where: { conversationId: id, userId: b },
        data: { lastReadAt: new Date() },
      }),
    );
    expect(moved.count).toBe(0);

    const club = await seedTenant({}, db);
    await expect(
      as({ userId: a }, (tx) =>
        tx.conversation.updateMany({ where: { id }, data: { tenantId: club.tenantId } }),
      ),
    ).rejects.toThrow(/never change/);
  });

  it('a creator seeds only the conversation’s own shape: no third player, no staff member as a person', async () => {
    const [a, b, c] = await Promise.all([player(), player(), player()]);
    const { id } = await openPlayerConversation({ kind: 'player', userId: a }, b);
    await expect(
      as({ userId: a }, (tx) =>
        tx.conversationParticipant.createMany({
          data: [{ conversationId: id, userId: c, role: 'MEMBER' }],
        }),
      ),
    ).rejects.toThrow(/row-level security/);

    const club = await seedTenant({}, db);
    await asAppSuperuser(db, (tx) =>
      tx.tenantMembership.create({
        data: { tenantId: club.tenantId, userId: a, role: 'PLAYER', status: 'ACTIVE' },
      }),
    );
    const { id: clubConv } = await openClubConversationWithPlayer(
      { kind: 'club', userId: club.userId, tenantId: club.tenantId },
      a,
    );
    await expect(
      as({ userId: club.userId, tenantId: club.tenantId }, (tx) =>
        tx.conversationParticipant.createMany({
          data: [{ conversationId: clubConv, userId: club.userId, role: 'PLAYER' }],
        }),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it('who blocked whom is visible to the two people it names, and written only by the blocker', async () => {
    const [a, b, c] = await Promise.all([player(), player(), player()]);
    await as({ userId: a }, (tx) =>
      tx.userBlock.createMany({ data: [{ blockerId: a, blockedId: b }] }),
    );
    expect(await as({ userId: a }, (tx) => tx.userBlock.count())).toBe(1);
    expect(await as({ userId: b }, (tx) => tx.userBlock.count())).toBe(1);
    expect(await as({ userId: c }, (tx) => tx.userBlock.count())).toBe(0);

    await expect(
      as({ userId: c }, (tx) =>
        tx.userBlock.createMany({ data: [{ blockerId: b, blockedId: c }] }),
      ),
    ).rejects.toThrow(/row-level security/);
    const lifted = await as({ userId: b }, (tx) =>
      tx.userBlock.deleteMany({ where: { blockerId: a, blockedId: b } }),
    );
    expect(lifted.count).toBe(0);
  });
});
