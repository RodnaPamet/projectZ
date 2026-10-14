-- P76b: validate P76's tombstone CHECK (#442), in a transaction of its own so
-- the scan runs under SHARE UPDATE EXCLUSIVE and not under P76's exclusive
-- lock (P52b explains).
--
-- Every row passes: the column is new and NULL everywhere.
SET lock_timeout = '5s';

ALTER TABLE "app_user" VALIDATE CONSTRAINT app_user_deleted_has_no_apple_subject;
