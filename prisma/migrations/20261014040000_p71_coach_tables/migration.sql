-- P71 (#544, module 3): the coach tables, as the coaches module uses them.
--
-- ═══ WHAT THIS REPLACES ═══
--
-- P08 created five coach tables (`coach`, `coach_sport`, `coach_availability`,
-- `coach_booking`, `coach_review`) for a module that was never built. Nothing
-- ever wrote them: both live databases held no row in any of them when this
-- was written (checked 2026-10-14), and the release before this one stopped
-- the one piece of code that still read them (account deletion), so the image
-- a rollback lands on does not query a column that is gone.
--
-- They are reshaped here to the owner's decisions of 2026-10-14 (#377):
--
--   coach_profile         one per COACH account: the profile and the owner's
--                         decision on it (13)
--   coach_profile_sport   the sports and player levels a coach teaches
--   coach_certificate     the uploaded certificate, encrypted, in the database
--                         and nowhere public (13, 17)
--   coach                 a coach AT A VENUE: the link, the rates (2, 9), the
--                         lengths taught (5), the cancellation cutoff (6)
--   coach_availability    the weekly hours at that venue (14)
--   coach_time_off        days away, everywhere at once (14)
--   coach_lesson          what a coach adds to a court booking (1); replaces
--                         coach_booking
--   coach_review          a player's review after a lesson (16)
--
-- ═══ IT REFUSES TO RUN OVER DATA ═══
--
-- If any of the five old tables holds a row, this stops before changing
-- anything: somebody wrote to scaffolding, and that needs a person, not a
-- DROP COLUMN.
--
-- Rollback: the previous image never touches these tables (see above), so it
-- runs against this schema. The new tables are only written with
-- MODULE_COACHES on.
SET lock_timeout = '5s';

DO $$
DECLARE
  n bigint;
BEGIN
  SELECT (SELECT count(*) FROM "coach")
       + (SELECT count(*) FROM "coach_sport")
       + (SELECT count(*) FROM "coach_availability")
       + (SELECT count(*) FROM "coach_booking")
       + (SELECT count(*) FROM "coach_review")
    INTO n;
  IF n > 0 THEN
    RAISE EXCEPTION
      'p71: the P08 coach tables hold % row(s). Nothing was meant to write them; find out what did before reshaping them (#544).', n;
  END IF;
END $$;

-- ─── 1. The tables, as prisma/schema/coach.prisma declares them ────────────

-- CreateEnum
CREATE TYPE "CoachProfileStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'APPROVED', 'DECLINED');

-- CreateEnum
CREATE TYPE "CoachLinkStatus" AS ENUM ('REQUESTED', 'INVITED', 'ACTIVE', 'DECLINED', 'ENDED');

-- DropForeignKey
ALTER TABLE "coach_booking" DROP CONSTRAINT "coach_booking_coachId_fkey";

-- DropForeignKey
ALTER TABLE "coach_booking" DROP CONSTRAINT "coach_booking_resourceId_fkey";

-- DropForeignKey
ALTER TABLE "coach_review" DROP CONSTRAINT "coach_review_coachId_fkey";

-- DropForeignKey
ALTER TABLE "coach_sport" DROP CONSTRAINT "coach_sport_coachId_fkey";

-- DropIndex
DROP INDEX "coach_tenantId_userId_key";

-- DropIndex
DROP INDEX "coach_userId_idx";

-- DropIndex
DROP INDEX "coach_review_coachId_authorUserId_key";

-- DropIndex
DROP INDEX "coach_review_coachId_createdAt_idx";

-- AlterTable
ALTER TABLE "coach" DROP COLUMN "bio",
DROP COLUMN "certificationsJson",
DROP COLUMN "sports",
DROP COLUMN "verified",
ADD COLUMN     "cancelCutoffHours" INTEGER NOT NULL DEFAULT 24,
ADD COLUMN     "decidedAt" TIMESTAMPTZ(3),
ADD COLUMN     "decidedByUserId" TEXT,
ADD COLUMN     "endedAt" TIMESTAMPTZ(3),
ADD COLUMN     "endedByUserId" TEXT,
ADD COLUMN     "groupRateCents" INTEGER,
ADD COLUMN     "lessonMinutes" INTEGER[],
ADD COLUMN     "startedBy" TEXT NOT NULL,
ADD COLUMN     "venueId" TEXT NOT NULL,
ALTER COLUMN "hourlyRateCents" DROP NOT NULL,
DROP COLUMN "status",
ADD COLUMN     "status" "CoachLinkStatus" NOT NULL;

-- AlterTable
ALTER TABLE "coach_availability" DROP COLUMN "effectiveFrom",
DROP COLUMN "effectiveTo",
DROP COLUMN "exceptionDate";

-- AlterTable
ALTER TABLE "coach_review" DROP COLUMN "coachId",
ADD COLUMN     "coachUserId" TEXT NOT NULL,
ADD COLUMN     "lessonId" TEXT NOT NULL,
ADD COLUMN     "status" "ReviewStatus" NOT NULL DEFAULT 'PUBLISHED',
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL;

-- DropTable
DROP TABLE "coach_booking";

-- DropTable
DROP TABLE "coach_sport";

-- CreateTable
CREATE TABLE "coach_profile" (
    "userId" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "bio" TEXT,
    "qualifications" TEXT,
    "status" "CoachProfileStatus" NOT NULL DEFAULT 'DRAFT',
    "submittedAt" TIMESTAMPTZ(3),
    "decidedAt" TIMESTAMPTZ(3),
    "decidedByUserId" TEXT,
    "decisionNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "coach_profile_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "coach_profile_sport" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "sport" "SportType" NOT NULL,
    "levelMin" INTEGER NOT NULL,
    "levelMax" INTEGER NOT NULL,

    CONSTRAINT "coach_profile_sport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "coach_certificate" (
    "userId" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "byteSize" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "content" BYTEA NOT NULL,
    "uploadedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "coach_certificate_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "coach_time_off" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "startDate" DATE NOT NULL,
    "endDate" DATE NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "coach_time_off_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "coach_lesson" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "coachId" TEXT NOT NULL,
    "coachUserId" TEXT NOT NULL,
    "startTs" TIMESTAMPTZ(3) NOT NULL,
    "endTs" TIMESTAMPTZ(3) NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "hourlyRateCents" INTEGER NOT NULL,
    "groupRateCents" INTEGER,
    "cancelCutoffHours" INTEGER NOT NULL,
    "coachFeeCents" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "coach_lesson_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "coach_profile_slug_key" ON "coach_profile"("slug");

-- CreateIndex
CREATE INDEX "coach_profile_status_idx" ON "coach_profile"("status");

-- CreateIndex
CREATE UNIQUE INDEX "coach_profile_sport_userId_sport_key" ON "coach_profile_sport"("userId", "sport");

-- CreateIndex
CREATE INDEX "coach_time_off_userId_startDate_idx" ON "coach_time_off"("userId", "startDate");

-- CreateIndex
CREATE UNIQUE INDEX "coach_lesson_bookingId_key" ON "coach_lesson"("bookingId");

-- CreateIndex
CREATE INDEX "coach_lesson_coachUserId_startTs_idx" ON "coach_lesson"("coachUserId", "startTs");

-- CreateIndex
CREATE INDEX "coach_lesson_tenantId_startTs_idx" ON "coach_lesson"("tenantId", "startTs");

-- CreateIndex
CREATE INDEX "coach_lesson_coachId_idx" ON "coach_lesson"("coachId");

-- CreateIndex
CREATE INDEX "coach_tenantId_status_idx" ON "coach"("tenantId", "status");

-- CreateIndex
CREATE INDEX "coach_userId_status_idx" ON "coach"("userId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "coach_venueId_userId_key" ON "coach"("venueId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "coach_review_lessonId_key" ON "coach_review"("lessonId");

-- CreateIndex
CREATE INDEX "coach_review_coachUserId_status_createdAt_idx" ON "coach_review"("coachUserId", "status", "createdAt");

-- AddForeignKey
ALTER TABLE "coach_profile_sport" ADD CONSTRAINT "coach_profile_sport_userId_fkey" FOREIGN KEY ("userId") REFERENCES "coach_profile"("userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "coach" ADD CONSTRAINT "coach_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "venue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "coach_lesson" ADD CONSTRAINT "coach_lesson_coachId_fkey" FOREIGN KEY ("coachId") REFERENCES "coach"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "coach_lesson" ADD CONSTRAINT "coach_lesson_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "booking"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "coach_review" ADD CONSTRAINT "coach_review_lessonId_fkey" FOREIGN KEY ("lessonId") REFERENCES "coach_lesson"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─── 2. What the columns may hold ──────────────────────────────────────────
--
-- The use cases validate all of this and say why in words. These are the
-- floor for every writer the use cases never see.

ALTER TABLE "coach_profile"
  ADD CONSTRAINT coach_profile_slug_format CHECK ("slug" ~ '^[a-z0-9][a-z0-9-]{1,63}$'),
  ADD CONSTRAINT coach_profile_bio_length CHECK ("bio" IS NULL OR char_length("bio") <= 1000),
  ADD CONSTRAINT coach_profile_qualifications_length
    CHECK ("qualifications" IS NULL OR char_length("qualifications") <= 1000),
  ADD CONSTRAINT coach_profile_decision_note_length
    CHECK ("decisionNote" IS NULL OR char_length("decisionNote") <= 500),
  -- A decision names who made it and when; an undecided profile names neither.
  ADD CONSTRAINT coach_profile_decision_complete CHECK (
    ("status" IN ('APPROVED', 'DECLINED')) = ("decidedAt" IS NOT NULL AND "decidedByUserId" IS NOT NULL)
  );

ALTER TABLE "coach_profile_sport"
  ADD CONSTRAINT coach_profile_sport_levels
    CHECK ("levelMin" BETWEEN 1 AND 7 AND "levelMax" BETWEEN 1 AND 7 AND "levelMin" <= "levelMax");

ALTER TABLE "coach_certificate"
  -- 5 MB of file; the stored ciphertext is a little larger.
  ADD CONSTRAINT coach_certificate_size CHECK ("byteSize" BETWEEN 1 AND 5242880),
  ADD CONSTRAINT coach_certificate_type
    CHECK ("mimeType" IN ('application/pdf', 'image/jpeg', 'image/png', 'image/webp')),
  ADD CONSTRAINT coach_certificate_sha256 CHECK ("sha256" ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT coach_certificate_name_length CHECK (char_length("fileName") BETWEEN 1 AND 200);

ALTER TABLE "coach"
  ADD CONSTRAINT coach_started_by CHECK ("startedBy" IN ('COACH', 'CLUB')),
  -- Cents per hour. 1000 EUR an hour is a typo, not a rate.
  ADD CONSTRAINT coach_hourly_rate CHECK ("hourlyRateCents" IS NULL OR "hourlyRateCents" BETWEEN 0 AND 100000),
  ADD CONSTRAINT coach_group_rate CHECK ("groupRateCents" IS NULL OR "groupRateCents" BETWEEN 0 AND 100000),
  -- Up to a week before; 0 means "until it starts".
  ADD CONSTRAINT coach_cancel_cutoff CHECK ("cancelCutoffHours" BETWEEN 0 AND 168),
  ADD CONSTRAINT coach_lesson_minutes CHECK (
    coalesce(array_length("lessonMinutes", 1), 0) <= 12
    AND 15 <= ALL ("lessonMinutes")
    AND 240 >= ALL ("lessonMinutes")
  );

ALTER TABLE "coach_availability"
  ADD CONSTRAINT coach_availability_day CHECK ("dayOfWeek" BETWEEN 0 AND 6),
  ADD CONSTRAINT coach_availability_hours CHECK ("closeTime" > "openTime");

ALTER TABLE "coach_time_off"
  ADD CONSTRAINT coach_time_off_range CHECK ("endDate" >= "startDate"),
  ADD CONSTRAINT coach_time_off_note_length CHECK ("note" IS NULL OR char_length("note") <= 200);

ALTER TABLE "coach_lesson"
  -- The same span a booking may have (booking_span_valid, P05).
  ADD CONSTRAINT coach_lesson_span_valid
    CHECK ("endTs" > "startTs" AND "endTs" - "startTs" <= INTERVAL '4 hours'),
  ADD CONSTRAINT coach_lesson_fees CHECK (
    "hourlyRateCents" >= 0 AND "coachFeeCents" >= 0
    AND ("groupRateCents" IS NULL OR "groupRateCents" >= 0)
    AND "cancelCutoffHours" BETWEEN 0 AND 168
  );

ALTER TABLE "coach_review"
  ADD CONSTRAINT coach_review_rating CHECK ("rating" BETWEEN 1 AND 5),
  ADD CONSTRAINT coach_review_body_length CHECK ("body" IS NULL OR char_length("body") <= 2000);

-- ─── 3. One coach, one place at a time, ACROSS CLUBS ───────────────────────
--
-- booking_no_overlap (P05) keeps two bookings off one court. This keeps one
-- coach out of two lessons, and it is on the coach's ACCOUNT, not on the
-- per-venue link: a coach who teaches at two clubs cannot be booked at both
-- for the same hour. `[)` so back-to-back lessons are legal, as back-to-back
-- bookings are. `active` is the booking still holding its court (below), so a
-- cancelled lesson frees the coach.
ALTER TABLE "coach_lesson"
  ADD CONSTRAINT coach_lesson_no_overlap
  EXCLUDE USING gist (
    "coachUserId" WITH =,
    tstzrange("startTs", "endTs", '[)') WITH &&
  )
  WHERE ("active");

-- ─── 4. A lesson follows its booking, whoever moves it ─────────────────────
--
-- The booking is the source of truth for WHEN and WHETHER: a player cancels
-- it, the desk moves it, the sweep completes it, a no-show is marked on it.
-- None of that code knows there is a coach. So the database carries the
-- change across: after any update of a booking's time or status, the lesson
-- on it (if there is one) takes the same time, and is `active` exactly while
-- the booking still holds its court (PENDING or CONFIRMED, as
-- booking_no_overlap counts them).
--
-- Moving a lesson onto an hour the coach already teaches then fails here, on
-- coach_lesson_no_overlap, and takes the booking's own update down with it:
-- the desk is told the move could not be made, rather than double-booking a
-- coach quietly.
--
-- SECURITY DEFINER with a pinned search_path, as P52's account check: the
-- writer of the booking may be bound to a role whose policies should not
-- decide whether the mirror is kept.
CREATE OR REPLACE FUNCTION coach_lesson_follow_booking() RETURNS trigger AS $$
BEGIN
  UPDATE "coach_lesson"
     SET "startTs" = NEW."startTs",
         "endTs" = NEW."endTs",
         "active" = NEW."status" IN ('PENDING', 'CONFIRMED'),
         "updatedAt" = now()
   WHERE "bookingId" = NEW."id";
  RETURN NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

REVOKE ALL ON FUNCTION coach_lesson_follow_booking() FROM PUBLIC;

DROP TRIGGER IF EXISTS booking_coach_lesson_follow_trg ON "booking";
CREATE TRIGGER booking_coach_lesson_follow_trg
  AFTER UPDATE OF "startTs", "endTs", "status" ON "booking"
  FOR EACH ROW EXECUTE FUNCTION coach_lesson_follow_booking();

-- ─── 5. Who may read and write what ────────────────────────────────────────
--
-- `coach`, `coach_availability` and `coach_review` keep the tenant policies
-- P05 gave them. `coach_lesson` is a club's row like them. The other four are
-- a PERSON's: owner-only on `app.user_id`, as notifications and sport levels
-- are. The public pages read approved profiles through a use case that says
-- so; no policy here opens a profile to anybody else.

ALTER TABLE "coach_lesson" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "coach_lesson" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "coach_lesson";
CREATE POLICY tenant_isolation ON "coach_lesson"
  USING ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));
DROP POLICY IF EXISTS superuser_bypass ON "coach_lesson";
CREATE POLICY superuser_bypass ON "coach_lesson" TO app_superuser
  USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON "coach_lesson" TO app_user, app_superuser;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['coach_profile', 'coach_profile_sport', 'coach_certificate', 'coach_time_off']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_owner_only', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I USING ("userId" = current_setting(''app.user_id'', true)) WITH CHECK ("userId" = current_setting(''app.user_id'', true))',
      t || '_owner_only', t);
    EXECUTE format('DROP POLICY IF EXISTS superuser_bypass ON %I', t);
    EXECUTE format('CREATE POLICY superuser_bypass ON %I TO app_superuser USING (true) WITH CHECK (true)', t);
    EXECUTE format('REVOKE ALL ON %I FROM app_user', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO app_user, app_superuser', t);
  END LOOP;
END $$;

-- ─── 6. A deleted account gains none of it (#465) ──────────────────────────
--
-- The columns that record who DECIDED something (decidedByUserId,
-- endedByUserId) have no trigger: `NEW_ROWS` in deletion-plan.ts says why.

DROP TRIGGER IF EXISTS coach_profile_account_not_deleted_trg ON "coach_profile";
CREATE TRIGGER coach_profile_account_not_deleted_trg
  BEFORE INSERT OR UPDATE OF "userId" ON "coach_profile"
  FOR EACH ROW EXECUTE FUNCTION account_not_deleted('userId');

DROP TRIGGER IF EXISTS coach_profile_sport_account_not_deleted_trg ON "coach_profile_sport";
CREATE TRIGGER coach_profile_sport_account_not_deleted_trg
  BEFORE INSERT OR UPDATE OF "userId" ON "coach_profile_sport"
  FOR EACH ROW EXECUTE FUNCTION account_not_deleted('userId');

DROP TRIGGER IF EXISTS coach_certificate_account_not_deleted_trg ON "coach_certificate";
CREATE TRIGGER coach_certificate_account_not_deleted_trg
  BEFORE INSERT OR UPDATE OF "userId" ON "coach_certificate"
  FOR EACH ROW EXECUTE FUNCTION account_not_deleted('userId');

DROP TRIGGER IF EXISTS coach_time_off_account_not_deleted_trg ON "coach_time_off";
CREATE TRIGGER coach_time_off_account_not_deleted_trg
  BEFORE INSERT OR UPDATE OF "userId" ON "coach_time_off"
  FOR EACH ROW EXECUTE FUNCTION account_not_deleted('userId');

DROP TRIGGER IF EXISTS coach_account_not_deleted_trg ON "coach";
CREATE TRIGGER coach_account_not_deleted_trg
  BEFORE INSERT OR UPDATE OF "userId" ON "coach"
  FOR EACH ROW EXECUTE FUNCTION account_not_deleted('userId');

DROP TRIGGER IF EXISTS coach_lesson_account_not_deleted_trg ON "coach_lesson";
CREATE TRIGGER coach_lesson_account_not_deleted_trg
  BEFORE INSERT OR UPDATE OF "coachUserId" ON "coach_lesson"
  FOR EACH ROW EXECUTE FUNCTION account_not_deleted('coachUserId');

DROP TRIGGER IF EXISTS coach_review_author_account_not_deleted_trg ON "coach_review";
CREATE TRIGGER coach_review_author_account_not_deleted_trg
  BEFORE INSERT OR UPDATE OF "authorUserId" ON "coach_review"
  FOR EACH ROW EXECUTE FUNCTION account_not_deleted('authorUserId');

DROP TRIGGER IF EXISTS coach_review_coach_account_not_deleted_trg ON "coach_review";
CREATE TRIGGER coach_review_coach_account_not_deleted_trg
  BEFORE INSERT OR UPDATE OF "coachUserId" ON "coach_review"
  FOR EACH ROW EXECUTE FUNCTION account_not_deleted('coachUserId');
