-- P88: a player's Google Calendar, kept in step with their schedule (owner
-- 2026-11-14).
--
-- Two tables, both the PERSON's: owner-only on app.user_id, failing closed
-- when it is unset, like the bell (P22) and the favourite clubs (P87).
--
--   google_calendar_connection  one per person: the encrypted refresh token,
--                               the Google account's address, the «playerz»
--                               calendar's id, and how the last sync went.
--   calendar_oauth_state        the single-use `state` of one consent, held by
--                               the server because the phone's consent sheet
--                               is ephemeral and carries no cookie.
--
-- And the triggers that tell the sync something changed (section 3).
--
-- Additive: new tables, a new type, new functions and triggers. The previous
-- image names none of them; its writes to booking and friends fire the
-- triggers, which only touch the new table.

-- ─── 1. The tables ────────────────────────────────────────────────────────

CREATE TYPE "GoogleCalendarStatus" AS ENUM ('ACTIVE', 'REVOKED');

CREATE TABLE "google_calendar_connection" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "refreshTokenEnc" TEXT NOT NULL,
    "googleEmail" TEXT,
    "scopes" TEXT[],
    "calendarId" TEXT,
    "locale" "Locale" NOT NULL DEFAULT 'bg',
    "status" "GoogleCalendarStatus" NOT NULL DEFAULT 'ACTIVE',
    "connectedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSyncAt" TIMESTAMPTZ(3),
    "lastResultJson" JSONB,
    "lastError" TEXT,
    "dirtyAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "google_calendar_connection_pkey" PRIMARY KEY ("id"),
    -- Ciphertext or nothing, as app_user.mfaSecret (#262): a plaintext token
    -- written by a path that forgot `encryptField` is refused here.
    CONSTRAINT "google_calendar_connection_token_is_envelope"
      CHECK ("refreshTokenEnc" LIKE 'v1:%')
);

CREATE TABLE "calendar_oauth_state" (
    "id" TEXT NOT NULL,
    "stateHash" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "client" TEXT NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "consumedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "calendar_oauth_state_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "calendar_oauth_state_client" CHECK ("client" IN ('ios', 'web'))
);

CREATE UNIQUE INDEX "google_calendar_connection_userId_key" ON "google_calendar_connection"("userId");
CREATE INDEX "google_calendar_connection_dirtyAt_idx" ON "google_calendar_connection"("dirtyAt");
CREATE INDEX "google_calendar_connection_status_lastSyncAt_idx" ON "google_calendar_connection"("status", "lastSyncAt");
CREATE UNIQUE INDEX "calendar_oauth_state_stateHash_key" ON "calendar_oauth_state"("stateHash");
CREATE INDEX "calendar_oauth_state_userId_idx" ON "calendar_oauth_state"("userId");
CREATE INDEX "calendar_oauth_state_expiresAt_idx" ON "calendar_oauth_state"("expiresAt");

-- ─── 2. Who may read and write them ───────────────────────────────────────
--
-- The person, as themselves. The two things that are nobody in particular go
-- through app_superuser and are pinned by name in superuser-call-sites: the
-- callback, which learns who started a consent only by claiming its state, and
-- the five-minute sync loop, which is a timer.

ALTER TABLE "google_calendar_connection" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "google_calendar_connection" FORCE ROW LEVEL SECURITY;
CREATE POLICY google_calendar_connection_owner_only ON "google_calendar_connection"
  USING ("userId" = current_setting('app.user_id', true))
  WITH CHECK ("userId" = current_setting('app.user_id', true));
GRANT SELECT, INSERT, UPDATE, DELETE ON "google_calendar_connection" TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON "google_calendar_connection" TO app_superuser;

ALTER TABLE "calendar_oauth_state" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "calendar_oauth_state" FORCE ROW LEVEL SECURITY;
CREATE POLICY calendar_oauth_state_owner_only ON "calendar_oauth_state"
  USING ("userId" = current_setting('app.user_id', true))
  WITH CHECK ("userId" = current_setting('app.user_id', true));
GRANT SELECT, INSERT, DELETE ON "calendar_oauth_state" TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON "calendar_oauth_state" TO app_superuser;

-- A deleted account gains nothing new (P69, #465).
DROP TRIGGER IF EXISTS google_calendar_connection_account_not_deleted_trg ON "google_calendar_connection";
CREATE TRIGGER google_calendar_connection_account_not_deleted_trg
  BEFORE INSERT OR UPDATE OF "userId" ON "google_calendar_connection"
  FOR EACH ROW EXECUTE FUNCTION account_not_deleted('userId');

DROP TRIGGER IF EXISTS calendar_oauth_state_account_not_deleted_trg ON "calendar_oauth_state";
CREATE TRIGGER calendar_oauth_state_account_not_deleted_trg
  BEFORE INSERT OR UPDATE OF "userId" ON "calendar_oauth_state"
  FOR EACH ROW EXECUTE FUNCTION account_not_deleted('userId');

-- ─── 3. Something on a connected person's schedule changed ────────────────
--
-- The sync loop runs every five minutes and syncs the connections marked
-- dirty. What marks them is HERE, in the same transaction as the change, for
-- the reason P71 gives for coach_lesson_follow_booking: a booking is changed
-- by a dozen use cases (a player books or cancels, the desk moves it, the
-- sweeps release and complete it, a player is added or leaves, a request to
-- join a game is accepted, a tournament match is placed), and none of them
-- knows there is a calendar. A mark in each would be a mark forgotten in the
-- next one. Rolled back with the change; nothing marked for a change that did
-- not happen.
--
-- `clock_timestamp()`, not `now()`: the sync clears the mark only if it still
-- holds the value it read before reading the schedule, so a change committed
-- while a sync runs keeps its (different) mark and is picked up next time.
--
-- SECURITY DEFINER with a pinned search_path, as P52 and P71: the writer of the
-- booking is bound to a club, and the connection is the person's row.
-- Each trigger returns at once while nobody is connected, so the sweeps that
-- touch hundreds of bookings pay one empty index probe each.

CREATE OR REPLACE FUNCTION calendar_mark_dirty(user_ids text[]) RETURNS void AS $$
BEGIN
  IF user_ids IS NULL OR cardinality(user_ids) = 0 THEN
    RETURN;
  END IF;
  UPDATE "google_calendar_connection"
     SET "dirtyAt" = clock_timestamp()
   WHERE "userId" = ANY(user_ids)
     AND "status" = 'ACTIVE';
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;
REVOKE ALL ON FUNCTION calendar_mark_dirty(text[]) FROM PUBLIC;

-- The booker (before and after), everyone on it, and the coach of its lesson.
CREATE OR REPLACE FUNCTION booking_calendar_dirty() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "google_calendar_connection") THEN
    RETURN NULL;
  END IF;
  PERFORM calendar_mark_dirty(ARRAY(
    SELECT NEW."bookedByUserId" WHERE NEW."bookedByUserId" IS NOT NULL
    UNION
    SELECT OLD."bookedByUserId" WHERE TG_OP = 'UPDATE' AND OLD."bookedByUserId" IS NOT NULL
    UNION
    SELECT p."userId" FROM "booking_participant" p
     WHERE p."bookingId" = NEW."id" AND p."userId" IS NOT NULL
    UNION
    SELECT l."coachUserId" FROM "coach_lesson" l WHERE l."bookingId" = NEW."id"
  ));
  RETURN NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;
REVOKE ALL ON FUNCTION booking_calendar_dirty() FROM PUBLIC;

DROP TRIGGER IF EXISTS booking_calendar_dirty_trg ON "booking";
CREATE TRIGGER booking_calendar_dirty_trg
  AFTER INSERT OR UPDATE OF "startTs", "endTs", "status", "resourceId", "bookedByUserId", "notes"
  ON "booking"
  FOR EACH ROW EXECUTE FUNCTION booking_calendar_dirty();

-- A person added to a booking, leaving it, or taken off it.
CREATE OR REPLACE FUNCTION booking_participant_calendar_dirty() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "google_calendar_connection") THEN
    RETURN NULL;
  END IF;
  IF TG_OP = 'INSERT' THEN
    PERFORM calendar_mark_dirty(ARRAY[NEW."userId"]);
  ELSIF TG_OP = 'DELETE' THEN
    PERFORM calendar_mark_dirty(ARRAY[OLD."userId"]);
  ELSE
    PERFORM calendar_mark_dirty(ARRAY[OLD."userId", NEW."userId"]);
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;
REVOKE ALL ON FUNCTION booking_participant_calendar_dirty() FROM PUBLIC;

DROP TRIGGER IF EXISTS booking_participant_calendar_dirty_trg ON "booking_participant";
CREATE TRIGGER booking_participant_calendar_dirty_trg
  AFTER INSERT OR DELETE OR UPDATE OF "userId" ON "booking_participant"
  FOR EACH ROW EXECUTE FUNCTION booking_participant_calendar_dirty();

-- A lesson booked: its coach. (Its time and status follow the booking, whose
-- own trigger names the coach.)
CREATE OR REPLACE FUNCTION coach_lesson_calendar_dirty() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "google_calendar_connection") THEN
    RETURN NULL;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    PERFORM calendar_mark_dirty(ARRAY[OLD."coachUserId", NEW."coachUserId"]);
  ELSE
    PERFORM calendar_mark_dirty(ARRAY[NEW."coachUserId"]);
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;
REVOKE ALL ON FUNCTION coach_lesson_calendar_dirty() FROM PUBLIC;

DROP TRIGGER IF EXISTS coach_lesson_calendar_dirty_trg ON "coach_lesson";
CREATE TRIGGER coach_lesson_calendar_dirty_trg
  AFTER INSERT OR UPDATE OF "coachUserId", "active" ON "coach_lesson"
  FOR EACH ROW EXECUTE FUNCTION coach_lesson_calendar_dirty();

-- A request to join an open game decided. Accepting it adds the asker to the
-- booking, which the participant trigger sees too; this one is for the status
-- itself, so the asker's calendar is re-read whichever way it went.
CREATE OR REPLACE FUNCTION open_game_request_calendar_dirty() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "google_calendar_connection") THEN
    RETURN NULL;
  END IF;
  PERFORM calendar_mark_dirty(ARRAY[NEW."userId"]);
  RETURN NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;
REVOKE ALL ON FUNCTION open_game_request_calendar_dirty() FROM PUBLIC;

DROP TRIGGER IF EXISTS open_game_request_calendar_dirty_trg ON "open_game_request";
CREATE TRIGGER open_game_request_calendar_dirty_trg
  AFTER UPDATE OF "status" ON "open_game_request"
  FOR EACH ROW EXECUTE FUNCTION open_game_request_calendar_dirty();
