-- P41: a public address for every venue, `/venues/{publicSlug}` (#355).
--
-- ═══ WHY A NEW COLUMN, NOT `venue.slug` ═══
--
-- `venue.slug` is unique only WITHIN a club (`@@unique([tenantId, slug])`), so
-- two clubs may both own `central-courts`. A public URL that carries only a
-- slug cannot say which one it means. `publicSlug` is unique everywhere.
--
-- ═══ ADDITIVE ONLY ═══
--
-- Production rolls back by re-tagging the previous image, which must keep
-- working against this schema. The column is nullable and the previous image
-- never names it; the trigger below fills it on every INSERT, so a venue that
-- image creates gets an address too.
--
-- ═══ HOW A SLUG IS CHOSEN ═══
--
-- The venue's own slug, normalised to `[a-z0-9-]`. If another venue already
-- holds it, the club's slug is appended (`central-courts-slot-club`), and if
-- that is taken as well, six characters of the venue id's hash. Once set it
-- never changes: a public URL that moves breaks every link and search result
-- that points at it, so a later edit of `venue.slug` leaves it alone.

ALTER TABLE "venue" ADD COLUMN "publicSlug" TEXT;

-- The check runs across every club, and `venue` and `venue_org` carry FORCE
-- row security keyed on one tenant. The function therefore runs as
-- app_superuser (BYPASSRLS), takes nothing from the caller but the row being
-- written, and pins its search_path.
CREATE OR REPLACE FUNCTION venue_public_slug_for(p_id text, p_tenant_id text, p_slug text)
RETURNS text AS $$
DECLARE
  base text;
  candidate text;
  club_slug text;
BEGIN
  base := trim(BOTH '-' FROM regexp_replace(lower(coalesce(p_slug, '')), '[^a-z0-9]+', '-', 'g'));
  IF base = '' THEN
    base := 'venue';
  END IF;

  candidate := base;
  IF NOT EXISTS (SELECT 1 FROM "venue" WHERE "publicSlug" = candidate AND "id" <> p_id) THEN
    RETURN candidate;
  END IF;

  SELECT trim(BOTH '-' FROM regexp_replace(lower(o."slug"), '[^a-z0-9]+', '-', 'g'))
    INTO club_slug
    FROM "venue_org" AS o
   WHERE o."id" = p_tenant_id;

  IF club_slug IS NOT NULL AND club_slug <> '' AND club_slug <> base THEN
    candidate := base || '-' || club_slug;
    IF NOT EXISTS (SELECT 1 FROM "venue" WHERE "publicSlug" = candidate AND "id" <> p_id) THEN
      RETURN candidate;
    END IF;
  END IF;

  RETURN base || '-' || substr(md5(p_id), 1, 6);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

ALTER FUNCTION venue_public_slug_for(text, text, text) OWNER TO app_superuser;
REVOKE ALL ON FUNCTION venue_public_slug_for(text, text, text) FROM PUBLIC;

-- Fills the column when the writer did not. A writer that sets it (a future
-- admin screen) keeps what it chose, and the unique index arbitrates.
CREATE OR REPLACE FUNCTION venue_fill_public_slug() RETURNS trigger AS $$
BEGIN
  IF NEW."publicSlug" IS NULL THEN
    NEW."publicSlug" := venue_public_slug_for(NEW."id", NEW."tenantId", NEW."slug");
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

ALTER FUNCTION venue_fill_public_slug() OWNER TO app_superuser;
REVOKE ALL ON FUNCTION venue_fill_public_slug() FROM PUBLIC;

DROP TRIGGER IF EXISTS venue_fill_public_slug_trg ON "venue";
CREATE TRIGGER venue_fill_public_slug_trg
  BEFORE INSERT ON "venue"
  FOR EACH ROW EXECUTE FUNCTION venue_fill_public_slug();

-- ═══ BACKFILL ═══
--
-- Oldest first, one row at a time, so the venue that has held a slug longest
-- keeps the plain form. As app_superuser: under FORCE row security the
-- migration's own role would otherwise see no venue at all.
SET ROLE app_superuser;
DO $$
DECLARE
  v record;
BEGIN
  FOR v IN
    SELECT "id", "tenantId", "slug" FROM "venue"
     WHERE "publicSlug" IS NULL
     ORDER BY "createdAt", "id"
  LOOP
    UPDATE "venue"
       SET "publicSlug" = venue_public_slug_for(v."id", v."tenantId", v."slug")
     WHERE "id" = v."id";
  END LOOP;
END;
$$;
RESET ROLE;

CREATE UNIQUE INDEX "venue_publicSlug_key" ON "venue"("publicSlug");
