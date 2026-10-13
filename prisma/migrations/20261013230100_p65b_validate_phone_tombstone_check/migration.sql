-- P65b: validate P65's tombstone CHECK (#500), in a transaction of its own so
-- the scan runs under SHARE UPDATE EXCLUSIVE and not under P65's exclusive
-- lock (P52b explains).
--
-- Every row passes: both columns are new and NULL everywhere.
SET lock_timeout = '5s';

ALTER TABLE "app_user" VALIDATE CONSTRAINT app_user_deleted_has_no_phone;
