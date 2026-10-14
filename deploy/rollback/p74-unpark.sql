-- ROLLING FORWARD AGAIN AFTER p74-park.sql: give back what it parked.
--
-- The COACH_REVIEW reports and their cases return to their tables, and the park
-- tables go. Run it once the P74 (or later) image is running again. Safe when
-- nothing was parked: the tables are created empty first.
--
--   docker exec -i playerz-db psql -U playerz -d playerz_production -v ON_ERROR_STOP=1 \
--     < /opt/playerz/repo/deploy/rollback/p74-unpark.sql

BEGIN;

CREATE TABLE IF NOT EXISTS "p74_parked_moderation_case" (LIKE "moderation_case");
ALTER TABLE "p74_parked_moderation_case" ALTER COLUMN "subjectType" TYPE TEXT;
CREATE TABLE IF NOT EXISTS "p74_parked_content_report" (LIKE "content_report");
ALTER TABLE "p74_parked_content_report" ALTER COLUMN "subjectType" TYPE TEXT;

INSERT INTO "moderation_case"
SELECT "id", "tenantId", "subjectType"::"ModerationSubject", "subjectId", "status", "reason",
       "scoresJson", "reportedByUserId", "resolvedByUserId", "resolvedAt", "resolutionNote",
       "createdAt", "updatedAt"
FROM "p74_parked_moderation_case"
ON CONFLICT DO NOTHING;

INSERT INTO "content_report"
SELECT "id", "tenantId", "subjectType"::"ModerationSubject", "subjectId", "reporterUserId",
       "reason", "createdAt"
FROM "p74_parked_content_report"
ON CONFLICT DO NOTHING;

DROP TABLE "p74_parked_moderation_case";
DROP TABLE "p74_parked_content_report";

COMMIT;
