-- P57: platform-level reports are not readable by app_user (#483).
--
-- moderation_case and content_report read `"tenantId" IS NULL OR "tenantId" =
-- app.tenant_id` (P17, kept by P23). A platform-level row (tenantId NULL) was
-- therefore readable by every app_user session, whatever club it was bound to,
-- or none: the subject's id and, on content_report, the reporter's id and their
-- own words. Message reports (#375) are platform-level by design, so that
-- included who reported whom in a chat.
--
-- USING governs UPDATE and DELETE too, so it was more than a read. Measured
-- before this migration: a session bound to any club could DELETE a platform
-- case, or UPDATE its tenantId to its own club, which passes the P23 WITH CHECK.
-- That is the two-step re-parenting P23 closed on INSERT, left open on UPDATE.
--
-- Now both tables match the tenant and nothing else. A club still sees its own
-- rows exactly as before. Platform-level rows are reached only through the
-- BYPASSRLS bindings, which is how every call site already reaches them:
--   reporting       fileChatReport -> runAsSuperuser (messaging-directory.ts)
--   the queue       asPlatformAdmin -> listModerationCases, resolveChatCase,
--                   resolveCase (api/v1/platform/moderation/**)
--   deletion        deleteMyAccount -> runAsSuperuser (account-deletion.ts)
-- No app_user path reads a platform-level row, a reporter's own report
-- included, so no `app.user_id` branch is added.
--
-- ALTER POLICY, not DROP and CREATE: one statement, the roles (PUBLIC) kept,
-- and no moment without a policy. Narrowing only: the previous image never
-- reads these rows as app_user, so a rollback needs no park script. It waits
-- five seconds at most for its locks, then fails, and the deploy is run again.
SET lock_timeout = '5s';

ALTER POLICY moderation_case_tenant_isolation ON "moderation_case"
  USING ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

ALTER POLICY content_report_tenant_isolation ON "content_report"
  USING ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));
