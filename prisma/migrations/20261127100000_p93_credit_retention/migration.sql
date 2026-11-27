-- P93: credit movements leave the person after 5 years (owner 2026-11-27).
--
-- The privacy policy (section 13) now says: a club credit balance keeps its
-- movements while it is in use; once it is zero and its newest movement is
-- 5 years old, the movements are anonymised. retention-sweep.ts does that,
-- and only for a whole history at once, so a sum somebody still reads never
-- changes (balances are SUMs of `deltaCents` per club and person).
--
-- ═══ WHAT THE TRIGGER NOW ADMITS ═══
--
-- `credit_ledger_entry` (P16) refuses every UPDATE and DELETE. An UPDATE is
-- now admitted when ALL of:
--
--   - it runs as app_superuser with `app.retention_sweep` 'on' (SET LOCAL,
--     which only retention-sweep.ts does), as P92's audit deletes;
--   - the row is over 5 years old by the database's own clock;
--   - it changes nothing but who and what for: `userId` becomes
--     'anonymised', `refType` and `refId` become NULL. The amount, the
--     reason, the running balance, the club and the time stay exactly as
--     they were, so the club's figures do not move.
--
-- DELETE stays refused, whoever asks. Additive: one function body; the
-- previous image never sets the setting, so it behaves as before.
SET lock_timeout = '5s';

CREATE OR REPLACE FUNCTION ledger_append_only() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND current_user = 'app_superuser'
     AND current_setting('app.retention_sweep', true) = 'on'
     AND OLD."createdAt" < (now() AT TIME ZONE 'UTC') - interval '5 years'
     AND NEW."userId" = 'anonymised'
     AND NEW."refType" IS NULL
     AND NEW."refId" IS NULL
     AND NEW.id = OLD.id
     AND NEW."tenantId" = OLD."tenantId"
     AND NEW."deltaCents" = OLD."deltaCents"
     AND NEW.reason = OLD.reason
     AND NEW."balanceAfterCents" = OLD."balanceAfterCents"
     AND NEW."createdAt" = OLD."createdAt" THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION
    'credit_ledger_entry is APPEND-ONLY: % is not permitted. A ledger you can rewrite is not a ledger. To correct a balance, INSERT a compensating entry (reason=ADMIN_ADJUST). (Only the retention sweep anonymises, and only movements over 5 years old.)',
    TG_OP
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;
