import type { SportType } from '@prisma/client';

import { PlayerAccountRequiredError } from '@/app-layer/usecases/club-membership';
import { runAsUserOnly } from '@/lib/db/rls-middleware';
import { AppError, NotFoundError, ValidationError } from '@/lib/errors/types';
import { scoreSurvey, surveyFor } from '@/lib/ratings/skill-survey';

/**
 * A player's answers to «Вземи начално ниво» (#689) become their declared
 * level in that sport: where their rating starts (`seedRating`).
 *
 * Only BEFORE a first counted match. After one the level moves on results,
 * and a questionnaire must not move it back: 409 `RATING_STARTED`. A CLUB
 * account plays nothing (#263): 403, as `PATCH /me` answers its sports.
 *
 * The caller's own rows, as `updateMyProfile` writes them: `player_sport_level`
 * and `skill_rating_history` are owner-only under RLS, so runAsUserOnly.
 */
export async function submitSkillSurvey(
  userId: string,
  sport: SportType,
  answers: Record<string, string>,
): Promise<number> {
  if (!surveyFor(sport)) throw new NotFoundError('No questionnaire for this sport');
  const level = scoreSurvey(sport, answers);
  if (level === null) {
    throw new ValidationError('Answer every question once', { field: 'answers' });
  }
  return runAsUserOnly(userId, async (db) => {
    const user = await db.user.findUnique({
      where: { id: userId },
      select: { accountKind: true, locale: true },
    });
    if (user?.accountKind === 'CLUB') {
      throw new PlayerAccountRequiredError(
        user.locale === 'en'
          ? 'Levels belong to a player account. Sign in with your player account.'
          : 'Нивата са за профил на играч. Влезте с профила си на играч.',
      );
    }
    const rated = await db.skillRatingHistory.findFirst({
      where: { userId, sport },
      select: { id: true },
    });
    if (rated) {
      throw new AppError(
        'The rating in this sport already moves on results',
        'RATING_STARTED',
        409,
        true,
      );
    }
    await db.playerSportLevel.upsert({
      where: { userId_sport: { userId, sport } },
      create: { userId, sport, level },
      update: { level },
    });
    return level;
  });
}
