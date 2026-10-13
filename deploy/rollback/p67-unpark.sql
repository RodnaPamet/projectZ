-- ROLLING FORWARD AGAIN AFTER p67-park.sql: give back what it parked.
--
-- The OPEN_GAME_NOTE reports and their cases return to their tables, and the park
-- tables go. Run it once the P67 (or later) image is running again. Safe when
-- nothing was parked: the tables are created empty first.
--
--   docker exec -i playerz-db psql -U playerz -d playerz_production -v ON_ERROR_STOP=1 \
--     < /opt/playerz/repo/deploy/rollback/p67-unpark.sql

BEGIN;

CREATE TABLE IF NOT EXISTS "p67_parked_moderation_case" (LIKE "moderation_case");
ALTER TABLE "p67_parked_moderation_case" ALTER COLUMN "subjectType" TYPE TEXT;
CREATE TABLE IF NOT EXISTS "p67_parked_content_report" (LIKE "content_report");
ALTER TABLE "p67_parked_content_report" ALTER COLUMN "subjectType" TYPE TEXT;

INSERT INTO "moderation_case"
SELECT "id", "tenantId", "subjectType"::"ModerationSubject", "subjectId", "status", "reason",
       "scoresJson", "reportedByUserId", "resolvedByUserId", "resolvedAt", "resolutionNote",
       "createdAt", "updatedAt"
FROM "p67_parked_moderation_case"
ON CONFLICT DO NOTHING;

INSERT INTO "content_report"
SELECT "id", "tenantId", "subjectType"::"ModerationSubject", "subjectId", "reporterUserId",
       "reason", "createdAt"
FROM "p67_parked_content_report"
ON CONFLICT DO NOTHING;

DROP TABLE "p67_parked_moderation_case";
DROP TABLE "p67_parked_content_report";

COMMIT;
