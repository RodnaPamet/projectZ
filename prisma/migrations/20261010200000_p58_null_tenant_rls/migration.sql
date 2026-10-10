-- P58: a NULL-tenant row is not every app_user's (#488).
--
-- P57 (#483) removed `"tenantId" IS NULL OR "tenantId" = app.tenant_id` from
-- the two report tables. The same USING was still installed on three more
-- tables, and a fourth inherits it through a subquery:
--
--   user_session       P04, asymmetric: WITH CHECK already tenant-only
--   xp_event           P18, WITH CHECK narrowed by P23
--   match_result       P19, WITH CHECK narrowed by P23
--   match_participant  P23, keyed on its match_result's tenant, NULL included
--
-- USING governs SELECT, UPDATE and DELETE. Measured before this migration, as
-- app_user bound to a club that does not own the row, or to no club at all:
--   user_session  another person's session read back, tokenHash and
--                 refreshTokenHash included, and DELETEd (signed out).
--   match_result  a platform-level match UPDATEd into the bound club: the new
--                 row passes WITH CHECK, so the two-step re-parenting P23
--                 closed on INSERT was open on UPDATE. A match is an OpenSkill
--                 input, and a rating cannot be un-computed.
--   xp_event      read and DELETEd (UPDATE is refused by xp_event_no_update_trg).
--   match_participant  read and DELETEd for any platform-level match.
--
-- Every session row is NULL-tenant (both sign-in paths pass `tenantId: null`),
-- so the old shape exposed every session in the database to every app_user.
--
-- Now all four match the tenant and nothing else. No app_user path reads a
-- NULL-tenant row of any of them, so no `app.user_id` branch is added:
--   user_session  every read and write is on runAsSuperuser: sign-in
--                 (createUserSession), lookup (checkSession, the refresh
--                 route), refresh (rotateRefreshToken, setRefreshToken), sign
--                 out (revokeSession), sign out everywhere (revokeAllSessions),
--                 touchSession, the MFA step-up (mfa.ts; assertFreshStepUp
--                 inside runAsPlatformAdmin), the data export and account
--                 deletion. A session lookup by token never runs as app_user.
--   xp_event, match_result, match_participant
--                 nothing in src/ binds app_user around them: recordMatch,
--                 awardXp and awardActivityXp have no caller outside tests, and
--                 account deletion removes a person's XP on runAsSuperuser.
-- A club still reads and writes its own rows exactly as before. WITH CHECK
-- equals USING, so a row can neither be written into nor moved to a club the
-- session is not bound to.
--
-- ALTER POLICY, not DROP and CREATE: one statement each, the roles (PUBLIC)
-- kept, and no moment without a policy. Narrowing only: the previous image
-- never reads these rows as app_user, so a rollback needs no park script. It
-- waits five seconds at most for its locks, then fails, and the deploy is run
-- again.
SET lock_timeout = '5s';

ALTER POLICY tenant_isolation ON "user_session"
  USING ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

ALTER POLICY xp_event_tenant_isolation ON "xp_event"
  USING ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

ALTER POLICY match_result_tenant_isolation ON "match_result"
  USING ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

-- The subquery already runs under match_result's own policy, so the line above
-- closes this table too. Its own text loses the NULL branch as well, so the
-- installed policy says what it does and the shape test can pin it.
ALTER POLICY match_participant_tenant_isolation ON "match_participant"
  USING (
    EXISTS (
      SELECT 1 FROM "match_result" m
      WHERE m."id" = "match_participant"."matchId"
        AND m."tenantId" = current_setting('app.tenant_id', true)
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM "match_result" m
      WHERE m."id" = "match_participant"."matchId"
        AND m."tenantId" = current_setting('app.tenant_id', true)
    )
  );
