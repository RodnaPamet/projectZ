-- P85: the venue plan (#623). Owner, 2026-10-20: positions from OpenStreetMap,
-- then the club adjusts; our own drawing under the courts, no map tiles.
--
-- A court's outline is a polygon in METRES in the venue's own frame: origin at
-- the venue's point (`venue.lat`/`lng`), x east, y north. Kept as JSON, an
-- array of [x, y] pairs, read through `parseOutline` (src/lib/venues/plan.ts),
-- which drops anything that is not a sane polygon. No outline means no plan:
-- the venue page keeps its list.

CREATE TYPE "PlanSource" AS ENUM ('OSM', 'CLUB');
CREATE TYPE "PlanFeatureKind" AS ENUM ('GROUNDS', 'BUILDING', 'ENTRANCE');

-- On the court row itself: its row security already covers it.
ALTER TABLE "court"
  ADD COLUMN "planOutline" JSONB,
  ADD COLUMN "planSource" "PlanSource",
  ADD COLUMN "planOsmWayId" BIGINT;

ALTER TABLE "court" ADD CONSTRAINT court_plan_whole
  CHECK (("planOutline" IS NULL) = ("planSource" IS NULL));
ALTER TABLE "court" ADD CONSTRAINT court_plan_outline_shape
  CHECK ("planOutline" IS NULL OR jsonb_typeof("planOutline") = 'array');
-- An OSM way id says where an outline came from; a club's own drawing has none.
ALTER TABLE "court" ADD CONSTRAINT court_plan_osm_way
  CHECK ("planOsmWayId" IS NULL OR "planSource" = 'OSM');

-- What else the plan shows: the grounds' outline, a building, the entrance.
CREATE TABLE "venue_plan_feature" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "kind" "PlanFeatureKind" NOT NULL,
    "outline" JSONB NOT NULL,
    "source" "PlanSource" NOT NULL,
    "osmWayId" BIGINT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "venue_plan_feature_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "venue_plan_feature_venueId_idx" ON "venue_plan_feature"("venueId");
CREATE INDEX "venue_plan_feature_tenantId_idx" ON "venue_plan_feature"("tenantId");

ALTER TABLE "venue_plan_feature" ADD CONSTRAINT "venue_plan_feature_venueId_fkey"
  FOREIGN KEY ("venueId") REFERENCES "venue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "venue_plan_feature" ADD CONSTRAINT venue_plan_feature_outline_shape
  CHECK (jsonb_typeof("outline") = 'array');
ALTER TABLE "venue_plan_feature" ADD CONSTRAINT venue_plan_feature_osm_way
  CHECK ("osmWayId" IS NULL OR "source" = 'OSM');

ALTER TABLE "venue_plan_feature" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "venue_plan_feature" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "venue_plan_feature"
  USING ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

CREATE POLICY superuser_bypass ON "venue_plan_feature" TO app_superuser
  USING (true) WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE, DELETE ON "venue_plan_feature" TO app_user, app_superuser;
