import type { PrismaClient } from '@prisma/client';

import { playerMayCancel } from '@/lib/booking/cutoff';
import { AppError } from '@/lib/errors/types';

/**
 * The part of open play (#376) that the players-on-a-booking code (#358)
 * needs: what happens when a player who JOINED THROUGH OPEN PLAY leaves the
 * booking or is taken off it. Its own module so booking-players.ts can call it
 * without importing open-play.ts, which imports booking-players.ts.
 *
 * Owner decision 2026-10-13, rule 2: a joiner can pull out until the club's
 * cancellation cutoff; their spot reopens and the booker is told. After the
 * cutoff they are on the booking and the no-show rule applies. The booker's
 * removing them follows the same cutoff, so the two cannot be told apart by
 * the club: a joiner on the booking after the cutoff is somebody the club can
 * expect.
 *
 * A player added by link or by the booker (#358) has no request, and leaves or
 * is removed until the start, as before.
 */

/** Every refusal open play gives, by code. */
export class OpenPlayError extends AppError {
  constructor(code: string, status: number, message: string) {
    super(message, code, status, true);
    this.name = 'OpenPlayError';
  }
}

export const cutoffPassed = () =>
  new OpenPlayError(
    'OPEN_PLAY_CUTOFF_PASSED',
    409,
    "The club's cancellation cutoff for this game has passed: who plays is settled.",
  );

/**
 * Called inside the tenant transaction that holds the booking's lock, before
 * the participant row is deleted. Returns the open-play request the place
 * belonged to, now LEFT or REMOVED, or null when the place was not an open-play
 * one. Throws `OPEN_PLAY_CUTOFF_PASSED` once the club's cutoff has passed.
 */
export async function releaseOpenPlayPlace(
  tx: PrismaClient,
  input: {
    tenantId: string;
    participantId: string;
    startTs: Date;
    cutoffHours: number;
    as: 'LEFT' | 'REMOVED';
    now: Date;
  },
): Promise<{ requestId: string; gameId: string } | null> {
  const request = await tx.openGameRequest.findFirst({
    where: { tenantId: input.tenantId, participantId: input.participantId, status: 'ACCEPTED' },
    select: { id: true, gameId: true },
  });
  if (!request) return null;
  if (!playerMayCancel(input.startTs, input.cutoffHours, input.now)) throw cutoffPassed();

  await tx.openGameRequest.updateMany({
    where: { id: request.id, tenantId: input.tenantId, status: 'ACCEPTED' },
    data: { status: input.as, participantId: null, decidedAt: input.now },
  });
  return { requestId: request.id, gameId: request.gameId };
}
