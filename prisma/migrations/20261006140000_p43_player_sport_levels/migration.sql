-- P43 (#359): the sports a player plays, each at a self-declared level 1–7 (Q37).
--
-- One row per (person, sport). The level is what the player SAYS, from
-- "1: just starting" to "7: competitor"; rankings (#378) take over from it.
-- Keyed to app_user rather than player_profile: a profile row needs a display
-- name, and most accounts have none yet.

-- CreateTable
CREATE TABLE "player_sport_level" (
    "userId" TEXT NOT NULL,
    "sport" "SportType" NOT NULL,
    "level" SMALLINT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "player_sport_level_pkey" PRIMARY KEY ("userId","sport")
);

-- AddForeignKey
ALTER TABLE "player_sport_level" ADD CONSTRAINT "player_sport_level_userId_fkey" FOREIGN KEY ("userId") REFERENCES "app_user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The range is the database's, not only the API's: a write that skipped the
-- zod schema (a script, a future route) still cannot store a 0 or an 8.
ALTER TABLE "player_sport_level" ADD CONSTRAINT player_sport_level_range
  CHECK ("level" BETWEEN 1 AND 7);

-- ─── RLS ─────────────────────────────────────────────────────────────
--
-- Owner-only, keyed on app.user_id, as push_subscription (P22) is. A level is
-- the player's own statement about themselves; nobody else writes it, and
-- nothing reads another person's yet. When matchmaking or a public profile
-- needs to, that read gets its own policy and its own review. The 2-arg
-- current_setting fails closed when the setting is absent.
ALTER TABLE "player_sport_level" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "player_sport_level" FORCE ROW LEVEL SECURITY;

CREATE POLICY player_sport_level_owner_only ON "player_sport_level"
  USING ("userId" = current_setting('app.user_id', true))
  WITH CHECK ("userId" = current_setting('app.user_id', true));

GRANT SELECT, INSERT, UPDATE, DELETE ON "player_sport_level" TO app_user, app_superuser;
