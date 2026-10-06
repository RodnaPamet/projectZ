import type { UpdateMeBody } from '@/app-layer/schemas/me';
import { PlayerAccountRequiredError } from '@/app-layer/usecases/club-membership';
import { runAsUserOnly } from '@/lib/db/rls-middleware';

/**
 * The player's own profile, written: `PATCH /api/v1/me` (#359).
 *
 * The display name (N01: a new account had none, and no way to set one) and
 * the sports they play, each with a self-declared level 1–7 (Q37). The avatar
 * is the sign-in provider's and is not written here; nor is the language,
 * which `/me/profile` saves through `usecases/my-locale` (#362).
 *
 * ═══ WHY runAsUserOnly ═══
 *
 * Both tables are the caller's own and neither is tenant-scoped. `app_user`
 * has no RLS (global by design), so the WHERE on the session's id is what
 * keeps this to one row; `player_sport_level` is owner-only under RLS keyed on
 * `app.user_id` (P43), so even a WHERE that went wrong could not write another
 * person's levels: the policy's WITH CHECK refuses a row for any other id.
 * No superuser, no tenant binding: there is no club in this at all.
 *
 * ═══ THE LIST IS REPLACED, NOT MERGED ═══
 *
 * `sports` is the whole list the player sees on the screen, so a sport left
 * out is a sport they no longer play. Delete-then-insert in one transaction:
 * a reader sees the old list or the new one, never half of each.
 */
export async function updateMyProfile(userId: string, body: UpdateMeBody): Promise<boolean> {
  return runAsUserOnly(userId, async (db) => {
    const user = await db.user.findUnique({
      where: { id: userId },
      select: { accountKind: true, locale: true },
    });
    // A live session over an account row that is gone: the route answers 401.
    if (!user) return false;

    // A CLUB account does not play (#263): it has no sports to declare, as it
    // has no bookings to make. Its name is still its own to set.
    if (body.sports !== undefined && user.accountKind === 'CLUB') {
      throw new PlayerAccountRequiredError(
        user.locale === 'en'
          ? 'Sports and levels belong to a player account. Sign in with your player account.'
          : 'Спортовете и нивата са за профил на играч. Влезте с профила си на играч.',
      );
    }

    if (body.name !== undefined) {
      await db.user.update({ where: { id: userId }, data: { name: body.name } });
    }

    if (body.sports !== undefined) {
      await db.playerSportLevel.deleteMany({ where: { userId } });
      if (body.sports.length > 0) {
        await db.playerSportLevel.createMany({
          data: body.sports.map((s) => ({ userId, sport: s.sport, level: s.level })),
        });
      }
    }
    return true;
  });
}
