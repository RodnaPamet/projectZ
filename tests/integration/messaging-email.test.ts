import {
  markConversationRead,
  openClubConversation,
  openPlayerConversation,
  sendMessage,
  type MessagingActor,
} from '@/app-layer/usecases/messaging';
import { EMAIL_DELAY_MS } from '@/app-layer/usecases/messaging-notify';
import { drainEmailOutbox } from '@/app-layer/usecases/notification-outbox';
import type { EmailProvider, OutgoingEmail } from '@/lib/email/provider';

import { prismaTestClient, seedAccount, seedTenant } from '../helpers/db';
import { asAppSuperuser } from '../helpers/rls';

/**
 * A message's email (#375): queued with the bell, sent only after about ten
 * minutes and only if the message is still unread, at most one an hour per
 * conversation, and only to people who leave «Съобщения» on. It names who
 * wrote and links the conversation; it never carries the text.
 */
describe('message emails (#375)', () => {
  const db = prismaTestClient();
  const MIN = 60_000;

  function recorder() {
    const sent: OutgoingEmail[] = [];
    const provider: EmailProvider = {
      name: 'resend',
      send: async (m) => {
        sent.push(m);
        return { ok: true, messageId: 'm' };
      },
    };
    return { sent, provider };
  }

  async function player(name: string): Promise<Extract<MessagingActor, { kind: 'player' }>> {
    const id = await seedAccount('PLAYER', db);
    await asAppSuperuser(db, (tx) => tx.user.update({ where: { id }, data: { name } }));
    return { kind: 'player', userId: id };
  }

  const rows = (userId: string) =>
    asAppSuperuser(db, (tx) =>
      tx.emailOutbox.findMany({
        where: { userId, category: 'messages' },
        orderBy: { createdAt: 'asc' },
        take: 10,
      }),
    );

  it('waits ten minutes, is sent while unread, never carries the text, and comes once an hour', async () => {
    const a = await player('Ана');
    const b = await player('Борис');
    const { id } = await openPlayerConversation(a, b.userId);
    const t0 = Date.now();
    await sendMessage(a, id, 'тайната фраза');

    const [row] = await rows(b.userId);
    expect(row!.nextAttemptAt.getTime()).toBeGreaterThanOrEqual(t0 + EMAIL_DELAY_MS - 1000);
    expect(row!.subject).toBe('Ана иска да ви пише в playerz.bg');
    expect(row!.text).toContain(`/messages/${id}`);
    expect(row!.text).not.toContain('тайната фраза');

    const { sent, provider } = recorder();
    // Too early: nothing is due.
    expect(await drainEmailOutbox({ now: new Date(t0 + 5 * MIN), provider })).toMatchObject({
      claimed: 0,
    });
    // Due, and still unread: sent.
    expect(await drainEmailOutbox({ now: new Date(t0 + 11 * MIN), provider })).toMatchObject({
      sent: 1,
    });
    expect(sent).toHaveLength(1);

    // Within the hour, another stretch of unread messages writes no second email.
    await markConversationRead(b, id);
    await asAppSuperuser(db, (tx) =>
      tx.conversation.update({ where: { id }, data: { acceptedAt: new Date() } }),
    );
    await sendMessage(a, id, 'още нещо');
    expect(await rows(b.userId)).toHaveLength(1);
  });

  it('is skipped when the message was read before it was due, and when «Съобщения» is off', async () => {
    const a = await player('Ана');
    const b = await player('Борис');
    const c = await player('Цвета');
    const { id } = await openPlayerConversation(a, b.userId);
    const t0 = Date.now();
    await sendMessage(a, id, 'Здравейте');
    await markConversationRead(b, id);

    await asAppSuperuser(db, (tx) =>
      tx.user.update({ where: { id: c.userId }, data: { emailMessages: false } }),
    );
    const { id: toC } = await openPlayerConversation(a, c.userId);
    await sendMessage(a, toC, 'Здравейте');

    const { sent, provider } = recorder();
    expect(await drainEmailOutbox({ now: new Date(t0 + 11 * MIN), provider })).toMatchObject({
      sent: 0,
      skipped: 2,
    });
    expect(sent).toHaveLength(0);
    expect((await rows(b.userId))[0]).toMatchObject({ status: 'SKIPPED', lastError: 'read' });
    expect((await rows(c.userId))[0]).toMatchObject({ status: 'SKIPPED', lastError: 'opted-out' });
  });

  it('a club is one inbox: once a colleague answered, nobody else is emailed', async () => {
    const club = await seedTenant({ name: 'Падел Център' }, db);
    const ivan = await seedAccount('CLUB', db);
    await asAppSuperuser(db, (tx) =>
      tx.tenantMembership.create({
        data: { tenantId: club.tenantId, userId: ivan, role: 'STAFF', status: 'ACTIVE' },
      }),
    );
    const p = await player('Петър');
    const { id } = await openClubConversation(p, club.tenantSlug);
    const t0 = Date.now();
    await sendMessage(p, id, 'Имате ли корт?');
    // Both staff were queued an email…
    expect((await rows(club.userId)).length + (await rows(ivan)).length).toBe(2);
    // …and Иван answers before they are due.
    await sendMessage({ kind: 'club', userId: ivan, tenantId: club.tenantId }, id, 'Да');

    const { sent, provider } = recorder();
    await drainEmailOutbox({ now: new Date(t0 + 11 * MIN), provider });
    // The player is emailed about Иван's reply; the owner is not emailed about
    // a question a colleague already answered.
    expect(sent.map((m) => m.subject)).toEqual(['Падел Център ви писа в playerz.bg']);
  });
});
