-- P52b: validate P52's tombstone CHECK (#370).
--
-- P52 added `app_user_deleted_is_scrubbed` NOT VALID, so it held its exclusive
-- lock on app_user without scanning the table. This scans it, under SHARE
-- UPDATE EXCLUSIVE, which lets every read and write carry on. A file of its
-- own because a migration is one transaction: run inside P52, the scan would
-- have happened under P52's exclusive lock all the same.
--
-- Every row passes: before P52 no row had `deletedAt`, and since P52 the
-- constraint has held for every row written (NOT VALID skips only the check of
-- what is already there). The same five-second lock budget as P52, for the
-- same reason.
SET lock_timeout = '5s';

ALTER TABLE "app_user" VALIDATE CONSTRAINT app_user_deleted_is_scrubbed;
