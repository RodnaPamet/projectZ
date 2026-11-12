-- P86: every venue names its city by a canonical key (#667).
--
-- ═══ WHY ═══
--
-- `venue.city` is free text a club typed, so the same city came back as
-- `Sofia` and `София`, and the phone's filters offered both (owner decision
-- 2026-11-12: a canonical city list, venues reference a city id). The key is
-- one of src/lib/geo/cities.ts (`CITY_SPELLINGS`), whose names live in the
-- message catalogues; `tests/guardrails/city-key-sql.test.ts` holds this
-- function to that list.
--
-- ═══ ADDITIVE ONLY ═══
--
-- Nullable column, filled by a trigger on every write of `city`, so the
-- previous image (which never names it) keeps working and its writes are
-- keyed too. A city outside the list keeps a null key and its raw text.

ALTER TABLE "venue" ADD COLUMN "cityKey" TEXT;

-- Lower-cased comparison, as `cityKey()` in TypeScript does. IMMUTABLE: it
-- reads nothing but its argument.
CREATE OR REPLACE FUNCTION venue_city_key_for(p_city text) RETURNS text AS $$
  SELECT CASE lower(btrim(coalesce(p_city, '')))
    WHEN 'sofia' THEN 'sofia'
    WHEN 'софия' THEN 'sofia'
    WHEN 'plovdiv' THEN 'plovdiv'
    WHEN 'пловдив' THEN 'plovdiv'
    WHEN 'varna' THEN 'varna'
    WHEN 'варна' THEN 'varna'
    WHEN 'burgas' THEN 'burgas'
    WHEN 'bourgas' THEN 'burgas'
    WHEN 'бургас' THEN 'burgas'
    WHEN 'ruse' THEN 'ruse'
    WHEN 'rousse' THEN 'ruse'
    WHEN 'русе' THEN 'ruse'
    WHEN 'stara zagora' THEN 'staraZagora'
    WHEN 'стара загора' THEN 'staraZagora'
    WHEN 'pleven' THEN 'pleven'
    WHEN 'плевен' THEN 'pleven'
    WHEN 'sliven' THEN 'sliven'
    WHEN 'сливен' THEN 'sliven'
    WHEN 'dobrich' THEN 'dobrich'
    WHEN 'добрич' THEN 'dobrich'
    WHEN 'shumen' THEN 'shumen'
    WHEN 'шумен' THEN 'shumen'
    WHEN 'pernik' THEN 'pernik'
    WHEN 'перник' THEN 'pernik'
    WHEN 'haskovo' THEN 'haskovo'
    WHEN 'хасково' THEN 'haskovo'
    WHEN 'yambol' THEN 'yambol'
    WHEN 'ямбол' THEN 'yambol'
    WHEN 'pazardzhik' THEN 'pazardzhik'
    WHEN 'пазарджик' THEN 'pazardzhik'
    WHEN 'blagoevgrad' THEN 'blagoevgrad'
    WHEN 'благоевград' THEN 'blagoevgrad'
    WHEN 'veliko tarnovo' THEN 'velikoTarnovo'
    WHEN 'veliko turnovo' THEN 'velikoTarnovo'
    WHEN 'велико търново' THEN 'velikoTarnovo'
    WHEN 'vratsa' THEN 'vratsa'
    WHEN 'враца' THEN 'vratsa'
    WHEN 'gabrovo' THEN 'gabrovo'
    WHEN 'габрово' THEN 'gabrovo'
    WHEN 'bansko' THEN 'bansko'
    WHEN 'банско' THEN 'bansko'
    WHEN 'samokov' THEN 'samokov'
    WHEN 'самоков' THEN 'samokov'
    ELSE NULL
  END;
$$ LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp;

CREATE OR REPLACE FUNCTION venue_fill_city_key() RETURNS trigger AS $$
BEGIN
  NEW."cityKey" := venue_city_key_for(NEW."city");
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public, pg_temp;

DROP TRIGGER IF EXISTS venue_fill_city_key_trg ON "venue";
CREATE TRIGGER venue_fill_city_key_trg
  BEFORE INSERT OR UPDATE OF "city" ON "venue"
  FOR EACH ROW EXECUTE FUNCTION venue_fill_city_key();

-- ═══ BACKFILL ═══
--
-- As app_superuser: under FORCE row security the migration's own role would
-- otherwise see no venue at all (see P41).
SET ROLE app_superuser;
UPDATE "venue" SET "cityKey" = venue_city_key_for("city");
RESET ROLE;

CREATE INDEX "venue_cityKey_idx" ON "venue"("cityKey");
