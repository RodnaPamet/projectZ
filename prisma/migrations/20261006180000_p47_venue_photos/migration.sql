-- P47 (#366): uploaded venue photos, a cover and a gallery. ADDITIVE only:
-- one new enum, six new nullable-or-defaulted columns on `venue_photo` (P05,
-- never written by the application before this), two new unique indexes and
-- one trigger.
--
-- The previous image keeps working against this schema: it reads `url`,
-- `alt` and `position`, which are unchanged, and it never writes the table.

-- CreateEnum
CREATE TYPE "VenuePhotoKind" AS ENUM ('COVER', 'GALLERY');

-- AlterTable
ALTER TABLE "venue_photo" ADD COLUMN     "blurDataUrl" TEXT,
ADD COLUMN     "height" INTEGER,
ADD COLUMN     "kind" "VenuePhotoKind" NOT NULL DEFAULT 'GALLERY',
ADD COLUMN     "objectKey" TEXT,
ADD COLUMN     "width" INTEGER,
ADD COLUMN     "widths" INTEGER[] DEFAULT ARRAY[]::INTEGER[];

-- One row per upload: the orphan sweep looks objects up by this stem.
-- CreateIndex
CREATE UNIQUE INDEX "venue_photo_objectKey_key" ON "venue_photo"("objectKey");

-- ─── At most one cover per venue ─────────────────────────────────────
--
-- A PARTIAL unique index, which Prisma cannot model (see the comment on
-- `VenuePhoto`), protected by tests/guardrails/migration-safety.test.ts. The
-- use case replaces a cover under a row lock on the venue; this is the
-- guarantee under a race between two uploads.
CREATE UNIQUE INDEX "venue_photo_one_cover_idx" ON "venue_photo"("venueId") WHERE "kind" = 'COVER';

-- ─── A photo belongs to its venue's club ─────────────────────────────
--
-- `venue_photo` is tenant-isolated (P05), but its foreign key to `venue` is
-- checked without row security: a row stamped with MY tenant could point at
-- ANOTHER club's venue, and the public venue page (BYPASSRLS) would show it.
-- The use case reads the venue under the tenant binding first; this makes it
-- a database fact as well. Run as the writer, so under app_user the lookup is
-- itself row-secured and another club's venue reads as missing.
CREATE OR REPLACE FUNCTION venue_photo_tenant_matches_venue() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  venue_tenant TEXT;
BEGIN
  SELECT "tenantId" INTO venue_tenant FROM "venue" WHERE "id" = NEW."venueId";
  IF venue_tenant IS NULL OR venue_tenant <> NEW."tenantId" THEN
    RAISE EXCEPTION 'venue_photo.tenantId must match its venue''s tenantId'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS venue_photo_tenant_matches_venue ON "venue_photo";
CREATE TRIGGER venue_photo_tenant_matches_venue
  BEFORE INSERT OR UPDATE OF "tenantId", "venueId" ON "venue_photo"
  FOR EACH ROW EXECUTE FUNCTION venue_photo_tenant_matches_venue();
