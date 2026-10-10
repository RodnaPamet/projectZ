import {
  getConversation,
  openClubConversation,
  openPlayerConversation,
  reportConversation,
  reportMessage,
  sendMessage,
  type MessagingActor,
} from '@/app-layer/usecases/messaging';
import { resolveChatCase } from '@/app-layer/usecases/moderation-messages';
import { listModerationCases } from '@/app-layer/usecases/moderation-queue';

import { prismaTestClient, seedAccount, seedTenant } from '../helpers/db';
import { asAppSuperuser } from '../helpers/rls';

/**
 * Report and moderation for messages (#375): a report joins the platform
 * queue reviews go to, one case per subject; the moderator sees the
 * conversation's lines and what the reports said, never who reported; a
 * decision removes the message, or closes the conversation for both sides.
 * The queue reads and decisions run on the BYPASSRLS handle the audited
 * platform binding gives them, as the routes do.
 */
describe('messaging moderation (#375)', () => {
  const db = prismaTestClient();

  async function player(name: string): Promise<Extract<MessagingActor, { kind: 'player' }>> {
    const id = await seedAccount('PLAYER', db);
    await asAppSuperuser(db, (tx) => tx.user.update({ where: { id }, data: { name } }));
    return { kind: 'player', userId: id };
  }

  const queue = () => asAppSuperuser(db, (tx) => listModerationCases(tx, {}));

  it('a reported message is ONE case however many report it, with its context and no reporter', async () => {
    const a = await player('Ана');
    const b = await player('Борис');
    const { id } = await openPlayerConversation(a, b.userId);
    await sendMessage(a, id, 'ти си никой');
    await sendMessage(b, id, 'моля?');
    const rude = (await getConversation(b, id)).messages[0]!.id;

    await expect(reportMessage(a, rude, { reason: 'abuse' })).rejects.toMatchObject({
      code: 'REPORT_OWN_MESSAGE',
    });
    await reportMessage(b, rude, { reason: 'abuse', details: '<b>обижда</b> ме' });
    await reportMessage(b, rude, { reason: 'abuse', details: 'пак' });

    const { items } = await queue();
    const cases = items.flatMap((i) => (i.subject === 'REVIEW' ? [] : [i]));
    expect(cases).toHaveLength(1);
    const item = cases[0]!;
    expect(item).toMatchObject({ subject: 'CHAT_MESSAGE', reason: 'user_report' });
    expect(item.reports).toEqual([{ reason: 'abuse — обижда ме', at: expect.any(Date) }]);
    expect(item.messages.map((m) => [m.body, m.reported, m.from.name])).toEqual([
      ['ти си никой', true, 'Ана'],
      ['моля?', false, 'Борис'],
    ]);
    expect(JSON.stringify(item)).not.toContain(b.userId);

    // REJECT: the message is gone, a tombstone in its place.
    const moderator = await seedAccount('PLAYER', db);
    const decided = await asAppSuperuser(db, (tx) =>
      resolveChatCase(tx, {
        caseId: item.caseId,
        moderatorUserId: moderator,
        approve: false,
        note: 'insults, removed per policy',
      }),
    );
    expect(decided).toMatchObject({ status: 'REJECTED', removed: 'message' });
    expect((await getConversation(b, id)).messages[0]).toMatchObject({ body: null, deleted: true });
    await expect(
      asAppSuperuser(db, (tx) =>
        resolveChatCase(tx, { caseId: item.caseId, moderatorUserId: moderator, approve: true }),
      ),
    ).rejects.toMatchObject({ name: 'CaseAlreadyResolvedError' });
  });

  it('a conversation closed by a moderator stops both sides, and neither can lift it', async () => {
    const club = await seedTenant({}, db);
    const staff: MessagingActor = { kind: 'club', userId: club.userId, tenantId: club.tenantId };
    const p = await player('Петър');
    const { id } = await openClubConversation(p, club.tenantSlug);
    await sendMessage(p, id, 'спам спам спам');

    await reportConversation(staff, id, { reason: 'spam' });
    // Somebody who cannot read it cannot report it.
    const stranger = await player('Непознат');
    await expect(reportConversation(stranger, id, { reason: 'spam' })).rejects.toMatchObject({
      code: 'CONVERSATION_NOT_FOUND',
    });

    const item = (await queue()).items.find((i) => i.subject === 'CONVERSATION')!;
    expect(item).toBeDefined();
    const moderator = await seedAccount('PLAYER', db);
    await asAppSuperuser(db, (tx) =>
      resolveChatCase(tx, {
        caseId: item.caseId,
        moderatorUserId: moderator,
        approve: false,
        note: 'spam from a throwaway account',
      }),
    );

    for (const who of [p, staff]) {
      expect(await getConversation(who, id)).toMatchObject({
        state: 'blocked',
        blockedByMe: false,
        canSend: false,
      });
      await expect(sendMessage(who, id, 'ало')).rejects.toMatchObject({
        code: 'CONVERSATION_BLOCKED',
      });
    }
  });
});
