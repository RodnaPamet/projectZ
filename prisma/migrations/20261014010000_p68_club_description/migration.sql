-- P68 (#530): a description the club writes about itself.
--
-- A venue has had a description since P04; a club had none, so its public page
-- (`/clubs/{slug}`) could say nothing beyond a name, a phone and its venues.
-- The club's OWNER and MANAGER now write one, with each venue's description
-- and phone, under «Снимки и информация».
--
-- Plain text, sanitised on the way in. The length is the database's too: a
-- write that skipped the use case still cannot store a novel.
--
-- Rollback: additive. The previous image neither reads nor writes the column.
SET lock_timeout = '5s';

ALTER TABLE "venue_org" ADD COLUMN "description" TEXT;
ALTER TABLE "venue_org" ADD CONSTRAINT venue_org_description_length
  CHECK ("description" IS NULL OR char_length("description") <= 2000);
