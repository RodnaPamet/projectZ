import type { PrismaClient } from '@prisma/client';

import { parseChannel } from './channels';

/**
 * May this user subscribe to this channel?
 *
 * ═══ WHY THIS HAS TO EXIST AT ALL ═══
 *
 * `channels.ts` opens by saying a channel name IS an authorization boundary:
 * `conv:{id}` means everyone subscribed to that string can read every message
 * published to it. `mintConnectionToken` then deliberately carries `sub` and
 * nothing else, with the reasoning that "channel authorization is decided
 * per-subscription by the server, against the database, at subscribe time".
 *
 * Nothing decided it. `parseChannel` was written for this and had zero call
 * sites. So the design was sound and the half that enforces it was missing —
 * which, had Centrifugo been deployed without a subscribe proxy, would have
 * let any authenticated user subscribe to any conversation id they could
 * guess or observe.
 *
 * ═══ A DEPARTED PARTICIPANT IS NOT A PARTICIPANT ═══
 *
 * `ConversationParticipant` rows are KEPT on leave and marked with `leftAt`,
 * deliberately, so a departed member does not vanish from the history of a
 * conversation they were part of. That makes the obvious query — "is there a
 * participant row?" — wrong: it would let somebody who left keep receiving
 * every new message, live, for as long as they held a subscription.
 *
 * Reading the history they were present for is a different question, decided
 * elsewhere. This is about what arrives from now on.
 */

export type SubscribeDecision =
  | { allowed: true }
  | { allowed: false; reason: 'unknown-channel' | 'not-a-participant' | 'not-your-channel' };

export async function authorizeSubscription(
  db: PrismaClient,
  input: { userId: string; channel: string },
): Promise<SubscribeDecision> {
  const parsed = parseChannel(input.channel);

  // Unparseable means it is not a channel we issue. Denying is the only safe
  // answer: a channel shape we do not recognise is one whose authorization
  // rules we have not written.
  if (!parsed) return { allowed: false, reason: 'unknown-channel' };

  switch (parsed.kind) {
    case 'conversation': {
      const participant = await db.conversationParticipant.findFirst({
        where: {
          conversationId: parsed.id,
          userId: input.userId,
          // The whole point. See above.
          leftAt: null,
        },
        select: { userId: true },
      });

      return participant ? { allowed: true } : { allowed: false, reason: 'not-a-participant' };
    }

    case 'notification':
    case 'presence':
      // These are keyed by user id, so the check is identity, not membership:
      // you may listen to your own and nobody else's. No database round trip
      // — the token's `sub` is the authority, and it was signed by us.
      return parsed.id === input.userId
        ? { allowed: true }
        : { allowed: false, reason: 'not-your-channel' };
  }
}
