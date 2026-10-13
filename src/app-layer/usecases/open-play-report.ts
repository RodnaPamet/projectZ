import { reportReason, type ReportInput } from '@/app-layer/usecases/messaging';
import { fileChatReport, isLivePlayer } from '@/app-layer/usecases/messaging-directory';
import { gameNoteStanding } from '@/app-layer/usecases/open-play';
import { OpenPlayError } from '@/app-layer/usecases/open-play-roster';
import { RateLimitedError } from '@/lib/errors/types';
import { checkRateLimit, type RateLimitConfig } from '@/lib/security/rate-limit';

/**
 * Reporting the public note on a game (#526; owner decision 2026-10-13).
 *
 * A booker who opens a game may write a note on it. It is shown on Игри and on
 * the venue page to everyone, signed in or not, so it is the one piece of open
 * play that a stranger reads. A signed-in player reports it as they would a
 * message: a reason, and their own words if they want. The report joins the
 * platform's moderation queue (one open case per game, however many people
 * report it), the booker is not told, and the moderator never learns who
 * reported.
 *
 * What a moderator can do is clear the note (`resolveChatCase`). The game, its
 * booking and its players are untouched.
 *
 * ═══ WHO MAY REPORT ═══
 *
 * A player account, about a game they can see and did not open themselves,
 * while it has a note. A game whose booker and the caller have blocked each
 * other is not shown to the caller, so it answers as not found.
 */

/** Reports of game notes one account may file: a handful a day is plenty. */
export const GAME_NOTE_REPORT_LIMIT: RateLimitConfig = {
  maxAttempts: 10,
  windowMs: 24 * 3_600_000,
};

export async function reportGameNote(input: {
  userId: string;
  gameId: string;
  report: ReportInput;
}): Promise<{ reported: true }> {
  if (!(await isLivePlayer(input.userId))) {
    throw new OpenPlayError('PLAYER_ACCOUNT_REQUIRED', 403, 'Reporting needs a player account.');
  }

  const game = await gameNoteStanding(input.userId, input.gameId);
  if (!game) throw new OpenPlayError('GAME_NOT_FOUND', 404, 'That game was not found.');
  if (game.own) {
    throw new OpenPlayError('REPORT_OWN_NOTE', 400, 'You cannot report your own note.');
  }
  if (!game.hasNote) {
    throw new OpenPlayError('GAME_NOTE_NOT_FOUND', 404, 'This game has no note.');
  }

  const limit = await checkRateLimit(`game-note-report:u:${input.userId}`, GAME_NOTE_REPORT_LIMIT);
  if (!limit.allowed) throw new RateLimitedError('Too many reports. Try again tomorrow.');

  await fileChatReport({
    subjectType: 'OPEN_GAME_NOTE',
    subjectId: input.gameId,
    reporterUserId: input.userId,
    reason: reportReason(input.report),
  });
  return { reported: true };
}
