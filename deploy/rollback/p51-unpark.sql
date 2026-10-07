-- ROLLING FORWARD AGAIN: put back what p51-park.sql parked.
--
-- Run it once an image WITH P51 is serving again (docs/deploy-gcp.md, "Rolling
-- back past p51"): the previous image cannot read what this restores.
--
--   court               sport, resource type and status as they were parked,
--                       whatever the previous image did to them meanwhile: it
--                       could only see a closed tennis court.
--   player_sport_level  the parked levels, unless the player has set that
--                       sport again since (theirs wins), or the account is gone.
--
-- Then the two parking tables are dropped. Run as the database owner:
--
--   docker exec -i playerz-db psql -U playerz -d playerz_production -v ON_ERROR_STOP=1 \
--     < /opt/playerz/repo/deploy/rollback/p51-unpark.sql

BEGIN;

UPDATE "court" c
SET "sport" = p."sport"::"SportType",
    "resourceType" = p."resourceType"::"ResourceType",
    "status" = p."status"::"TenantStatus"
FROM "p51_parked_court" p
WHERE c."id" = p."id";

INSERT INTO "player_sport_level" ("userId", "sport", "level", "createdAt", "updatedAt")
SELECT p."userId", p."sport"::"SportType", p."level", p."createdAt", p."updatedAt"
FROM "p51_parked_sport_level" p
WHERE EXISTS (SELECT 1 FROM "app_user" u WHERE u."id" = p."userId")
ON CONFLICT ("userId", "sport") DO NOTHING;

DROP TABLE "p51_parked_court";
DROP TABLE "p51_parked_sport_level";

COMMIT;
