-- P92: the retention sweep (#717). The privacy policy in force since
-- 2026-11-15 (content/legal/*/privacy.md, section 13) says how long each kind
-- of record is kept; src/app-layer/usecases/retention-sweep.ts is the daily
-- job that keeps those words true. This file holds the two things the
-- database has to agree to before it can.
--
--   1. booking."anonymisedAt"   when the sweep took the people out of a
--                               booking five years after it ended. The row
--                               stays (club statistics, the fee ledger and
--                               results hang off it); the mark is how the
--                               sweep knows it is done with it, so a daily run
--                               never re-reads the years it already cleared.
--   2. Two append-only logs learn ONE kind of delete each: rows past the
--      period the policy names, deleted by the sweep, and nothing else.
--
-- ═══ WHAT THE TRIGGERS NOW ADMIT, AND WHY IT IS STILL APPEND-ONLY ═══
--
-- `audit_entry` (P26) and `account_security_event` (P38) refuse every UPDATE
-- and DELETE. The policy says the first is kept 5 years and the second 1 year,
-- so they cannot stay forever. A DELETE is now admitted when ALL of:
--
--   - the row is older than the period, by the database's own clock
--     (`now()`), not by a value the caller passes: a buggy or hostile caller
--     can at worst delete what the policy already says must go;
--   - the statement runs as app_superuser (`runAsSuperuser`), never as the
--     tenant-bound app_user role every request uses;
--   - the transaction set `app.retention_sweep` to 'on' (SET LOCAL, which only
--     retention-sweep.ts does). The setting is a statement of intent; the age
--     is the fact. Both, as P52's erasure branch asks for both.
--
-- Every UPDATE is refused as before (P52's address erasure on a deleted
-- account's security events stays exactly as it was), and so is every DELETE
-- of a row inside its period, whoever asks.
--
-- Both columns are `timestamp without time zone` written in UTC, so they are
-- compared with `now() AT TIME ZONE 'UTC'`.
--
-- ═══ ADDITIVE ═══
--
-- One nullable column (no rewrite, no default) and two function bodies. The
-- previous image never sets the column or the setting, so it runs unchanged
-- against this schema, and its triggers behave for it exactly as before.
SET lock_timeout = '5s';

-- 1. The booking's mark.
ALTER TABLE "booking" ADD COLUMN "anonymisedAt" TIMESTAMPTZ(3);

-- 2a. The club's history: 5 years (privacy policy section 13).
CREATE OR REPLACE FUNCTION audit_append_only() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE'
     AND current_user = 'app_superuser'
     AND current_setting('app.retention_sweep', true) = 'on'
     AND OLD."createdAt" < (now() AT TIME ZONE 'UTC') - interval '5 years' THEN
    RETURN OLD;
  END IF;

  RAISE EXCEPTION
    'audit_entry is APPEND-ONLY: % is not permitted. A history you can edit is not a history. To correct a mistaken entry, INSERT another recording the correction. (Only the retention sweep deletes, and only rows over 5 years old.)',
    TG_OP
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

-- 2b. The team's second-factor log: 1 year. P52's erasure branch is kept
--     word for word; the DELETE branch is new.
CREATE OR REPLACE FUNCTION account_security_event_append_only() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND current_setting('app.erasure_user_id', true) = OLD."userId"
     AND EXISTS (
       SELECT 1 FROM "app_user" AS u
        WHERE u."id" = OLD."userId" AND u."deletedAt" IS NOT NULL
     )
     AND NEW."ipAddress" IS NULL
     AND NEW."userAgent" IS NULL
     AND NEW."id" = OLD."id"
     AND NEW."userId" = OLD."userId"
     AND NEW."userSessionId" IS NOT DISTINCT FROM OLD."userSessionId"
     AND NEW."action" = OLD."action"
     AND NEW."detailsJson" = OLD."detailsJson"
     AND NEW."requestId" IS NOT DISTINCT FROM OLD."requestId"
     AND NEW."createdAt" = OLD."createdAt" THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE'
     AND current_user = 'app_superuser'
     AND current_setting('app.retention_sweep', true) = 'on'
     AND OLD."createdAt" < (now() AT TIME ZONE 'UTC') - interval '1 year' THEN
    RETURN OLD;
  END IF;

  RAISE EXCEPTION
    'account_security_event is APPEND-ONLY: % is not permitted. It is the record of who enrolled, stepped up or spent a recovery code; a record that can be edited is not evidence. (Only the retention sweep deletes, and only rows over 1 year old.)',
    TG_OP
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

-- P38 granted app_superuser SELECT and INSERT on the security log, P52 the
-- UPDATE of two columns. The DELETE the sweep needs is stated here rather than
-- left to P03's default privileges, which a later tightening could take away
-- without anyone thinking of the sweep.
GRANT DELETE ON "account_security_event" TO app_superuser;
GRANT DELETE ON "audit_entry" TO app_superuser;
