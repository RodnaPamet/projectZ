-- P23 — four RLS policies that do not do what they say.
--
-- Every one of these is a one-line mistake in an otherwise sound design. The
-- shape of the tenancy model is right; these are the places the shape was not
-- actually applied.

-- ═══════════════════════════════════════════════════════════════════
--  1. match_participant was open to everyone, in both directions.
-- ═══════════════════════════════════════════════════════════════════
--
-- The policy read, in full:
--
--     CREATE POLICY match_participant_readable ON "match_participant"
--       USING (true) WITH CHECK (true);
--
-- justified in P19 as "so the table cannot be reached without going through
-- the app roles". But app_user IS an app role, so it restricted nothing: every
-- tenant could read the entire who-played-whom graph, and — far worse — INSERT
-- rows into it.
--
-- That is not a privacy problem, it is a ratings problem. `recordMatch` feeds
-- OpenSkill from these rows (usecases/ratings.ts), so a forged LOSS is a
-- permanent, non-reversible rating change for somebody at another club. A
-- rating cannot be un-computed by subtraction.
--
-- The table has no tenantId of its own, so the policy is parent-keyed, exactly
-- as the P05 join tables are. The subquery is itself subject to match_result's
-- policy, which is the point: it can only see parents this session may see.
DROP POLICY IF EXISTS match_participant_readable ON "match_participant";

CREATE POLICY match_participant_tenant_isolation ON "match_participant"
  USING (
    EXISTS (
      SELECT 1 FROM "match_result" m
      WHERE m."id" = "match_participant"."matchId"
        AND (
          -- A NULL-tenant match is platform-level (a casual game logged
          -- outside any club) and stays readable, as its parent policy says.
          m."tenantId" IS NULL
          OR m."tenantId" = current_setting('app.tenant_id', true)
        )
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM "match_result" m
      WHERE m."id" = "match_participant"."matchId"
        -- No NULL escape on the write side. You may only add participants to a
        -- match belonging to the tenant you are bound to; a platform-level
        -- match is written by the superuser path that created it.
        AND m."tenantId" = current_setting('app.tenant_id', true)
    )
  );

-- ═══════════════════════════════════════════════════════════════════
--  2. activity: anyone could WRITE anyone else's non-Strava rows.
-- ═══════════════════════════════════════════════════════════════════
--
-- The policy was:
--
--     USING      (source <> 'STRAVA' OR "userId" = current_setting('app.user_id', true))
--     WITH CHECK (source <> 'STRAVA' OR "userId" = current_setting('app.user_id', true))
--
-- The READ half is deliberate and stays: an athlete's activity history follows
-- them between clubs, and `assertMayView` (lib/wearables/strava-tos.ts) is what
-- enforces Strava's cross-user prohibition at the boundary. Three of the four
-- ActivitySource values are not restricted, so those rows are meant to be
-- visible to other players.
--
-- Copying that clause into WITH CHECK was the mistake. `source <> 'STRAVA'` is
-- attacker-controlled on INSERT, so any session could create, alter or DELETE
-- another athlete's MANUAL, APPLE_HEALTH or GARMIN activity — including
-- deleting the evidence afterwards.
--
-- Writes are owner-only regardless of source. Nobody logs a workout on
-- somebody else's behalf.
-- ─── Why FOUR policies and not one ───────────────────────────────────
--
-- A single FOR ALL policy CANNOT express "readable by others, writable only by
-- the owner", and getting this wrong is silent. In Postgres:
--
--     USING      governs SELECT, UPDATE (which rows are visible) and DELETE
--     WITH CHECK governs INSERT and UPDATE (what the row may become)
--
-- So tightening only WITH CHECK blocks forging and leaves DELETE governed by
-- the permissive USING clause. Measured before this was split: another user
-- could still `DELETE FROM activity` and remove an athlete's workout history —
-- including, conveniently, the evidence.
--
-- Per-command policies are the only way to say it. Each command has exactly one
-- policy here, so there is no permissive-OR interaction to reason about.
DROP POLICY IF EXISTS activity_strava_owner_only ON "activity";

-- READ: deliberately permissive. An athlete's history follows them between
-- clubs, and `assertMayView` enforces Strava's cross-user prohibition at the
-- application boundary. Only STRAVA is owner-restricted here.
CREATE POLICY activity_select ON "activity" FOR SELECT
  USING (
    source <> 'STRAVA'
    OR "userId" = current_setting('app.user_id', true)
  );

-- WRITE: owner-only, every source. Nobody logs a workout for somebody else.
CREATE POLICY activity_insert ON "activity" FOR INSERT
  WITH CHECK ("userId" = current_setting('app.user_id', true));

CREATE POLICY activity_update ON "activity" FOR UPDATE
  USING ("userId" = current_setting('app.user_id', true))
  WITH CHECK ("userId" = current_setting('app.user_id', true));

CREATE POLICY activity_delete ON "activity" FOR DELETE
  USING ("userId" = current_setting('app.user_id', true));

-- ═══════════════════════════════════════════════════════════════════
--  3. Four tables accepted a NULL tenant on WRITE.
-- ═══════════════════════════════════════════════════════════════════
--
-- Each had `WITH CHECK ("tenantId" IS NULL OR "tenantId" = …)`, which permits
-- inserting a row belonging to no tenant — and then claiming it from another,
-- since the USING clause lets everyone read NULL-tenant rows. That is the
-- two-step re-parenting attack the asymmetric user_session policy (P04) was
-- written to block; the asymmetry was simply not carried over here.
--
-- USING keeps the NULL branch: platform-level rows exist and are meant to be
-- readable. Only the write side loses it. Genuine platform writes go through
-- the superuser path, which bypasses RLS and is obvious in review.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['xp_event', 'match_result', 'moderation_case', 'content_report']
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_tenant_isolation', t);
    EXECUTE format($f$
      CREATE POLICY %I ON %I
        USING ("tenantId" IS NULL OR "tenantId" = current_setting('app.tenant_id', true))
        WITH CHECK ("tenantId" = current_setting('app.tenant_id', true))
    $f$, t || '_tenant_isolation', t);
  END LOOP;
END $$;

-- ═══════════════════════════════════════════════════════════════════
--  4. password_reset_token had no RLS at all.
-- ═══════════════════════════════════════════════════════════════════
--
-- app_user holds SELECT, INSERT, UPDATE and DELETE on every table in the schema
-- (P03), so with no policy any authenticated session could read, forge or
-- delete any user's password-reset records. Only the fact that the column is a
-- `tokenHash` rather than the token itself made that non-trivial.
--
-- A reset is used by someone who is NOT yet signed in, so there is no
-- app.user_id to key a policy on. The table therefore denies app_user outright
-- and is reachable only through the superuser path — the same path sign-in
-- already uses to read a User before any tenant exists.
--
-- `USING (false)` rather than no policy at all: a table with RLS enabled and no
-- policy also denies, but silently and by omission. An explicit false says this
-- was decided.
ALTER TABLE "password_reset_token" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "password_reset_token" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS password_reset_token_superuser_only ON "password_reset_token";

CREATE POLICY password_reset_token_superuser_only ON "password_reset_token"
  USING (false)
  WITH CHECK (false);
