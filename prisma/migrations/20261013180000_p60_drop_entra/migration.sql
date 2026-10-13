-- P60 (#443): drop what P27 created for Microsoft Entra sign-in and the club
-- group sync, retired by #361.
--
-- Nothing has read or written these tables since #361 (released 2026-10-07).
-- Both were empty on production and staging when this was written
-- (2026-10-13). Every image since #361 runs without them, so rolling back to
-- one needs nothing; the image before #361 is not a rollback target any more.
--
-- DROP TABLE takes its indexes, CHECKs and RLS policies with it.
SET lock_timeout = '5s';

DROP TABLE IF EXISTS "tenant_entra_group_mapping";
DROP TABLE IF EXISTS "tenant_identity_provider";
DROP TYPE IF EXISTS "IdentityProviderType";
