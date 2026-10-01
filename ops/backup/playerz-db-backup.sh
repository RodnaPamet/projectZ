#!/usr/bin/env bash
# Nightly logical backup of playerz's production Postgres (#218).
#
# ═══ WHAT IT DOES ═══
#
#   1. `pg_dump -Fc` from inside `playerz-db`, to a root-only file on the host
#   2. `pg_restore --list` on that file — a dump that cannot be listed is not
#      worth uploading, and we would rather fail loudly here than at 3am later
#   3. upload to gs://$BUCKET/playerz/YYYY/MM/DD/playerz-<UTC timestamp>.dump
#   4. download it BACK, `cmp` it against the local file and `pg_restore --list`
#      the downloaded copy. That proves the object in the bucket — not the file
#      we meant to send — is a readable dump. A size check alone would pass a
#      truncated upload of a truncated dump.
#
# One line on success, one line naming the failed step on failure, both on
# stdout so they land in `journalctl -u playerz-db-backup`. A non-zero exit
# marks the unit failed, which `systemctl --failed` shows.
#
# ═══ WHY A SYSTEMD TIMER AND NOT A COMPOSE OVERLAY LIKE ops/sweep.compose.yml ═══
#
# The sweeps are HTTP pokes every minute, where a `sleep` loop in alpine is
# enough. This one needs three things a loop container does badly:
#
#   - a wall-clock time in a named zone (03:15 Europe/Sofia). A sleep loop
#     drifts and restarts from zero on every `compose up`; `OnCalendar=` does
#     neither, and `Persistent=true` runs a night that was missed while the VM
#     was down.
#   - `docker exec` into `playerz-db`. A container would need the Docker
#     socket mounted, which is root on the host for anything that can reach it
#     — including agrent's containers. On the host it is root already.
#   - gcloud. The host has it (Debian GCE image); no image to build or trust.
#
# ═══ CREDENTIALS: A DEDICATED SERVICE ACCOUNT, NOT THE VM'S ═══
#
# The VM's default service account has the `devstorage.read_only` ACCESS
# SCOPE. Scopes cap what the metadata-server token can do regardless of IAM,
# so no bucket binding would let it write. Changing scopes needs the VM
# STOPPED, which takes agrent down with it.
#
# So: `playerz-db-backup@hazel-design-419410.iam.gserviceaccount.com`, holding
# objectCreator + objectViewer on this ONE bucket and nothing in the project.
# Its key lives at $KEY_FILE, root:root 0600. objectCreator cannot delete or
# overwrite, so a compromised box can add junk but cannot destroy the history;
# the bucket's 30-day lifecycle rule is the only thing that deletes.
#
# `CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE` points gcloud at the key for THIS
# process only. `gcloud auth activate-service-account` would instead switch
# root's active account on a box agrent's operators also use.
#
# ═══ SECRETS ═══
#
# None are printed, and none are needed for the dump itself: `psql`/`pg_dump`
# inside the container use the unix socket, where the image's initdb set
# `trust` (see "The database roles" in docs/deploy-gcp.md). Never add `set -x`
# here — it would echo gcloud's environment, including the key path, into the
# journal for no benefit.
set -Eeuo pipefail

BUCKET="${PLAYERZ_BACKUP_BUCKET:-playerz-db-backups-hazel}"
CONTAINER="${PLAYERZ_DB_CONTAINER:-playerz-db}"
KEY_FILE="${PLAYERZ_BACKUP_KEY_FILE:-/etc/playerz-db-backup/sa-key.json}"
# systemd's StateDirectory= creates this 0700; the fallback is for a hand run.
WORK_ROOT="${STATE_DIRECTORY:-/var/lib/playerz-db-backup}"

export CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE="$KEY_FILE"
# A private gcloud config dir: gcloud writes logs and caches there, and root's
# own ~/.config/gcloud is not ours to scribble in.
export CLOUDSDK_CONFIG="$WORK_ROOT/gcloud"
export CLOUDSDK_CORE_DISABLE_PROMPTS=1

log() { echo "playerz-db-backup: $*"; }

step="start"
trap 'log "FAILED during: $step (line $LINENO, exit $?)"' ERR

umask 077
mkdir -p "$WORK_ROOT" "$CLOUDSDK_CONFIG"
work="$(mktemp -d "$WORK_ROOT/run.XXXXXX")"
# The local copies are deleted on every exit. The bucket is the backup; a
# second copy on the same disk protects against nothing the disk snapshot
# does not already cover, and 30 of them would fill it.
trap 'rm -rf "$work"' EXIT

step="read database name and user from $CONTAINER"
[ -r "$KEY_FILE" ] || { log "FAILED: key file $KEY_FILE missing or unreadable"; exit 1; }
# POSTGRES_DB / POSTGRES_USER are names, not secrets. Read them from the
# container rather than hard-coding `playerz_production` so a rename cannot
# leave this script dumping a database that no longer exists... successfully.
db="$(docker exec "$CONTAINER" printenv POSTGRES_DB)"
user="$(docker exec "$CONTAINER" printenv POSTGRES_USER)"

now_utc="$(date -u +%Y%m%dT%H%M%SZ)"
# UTC for the path as well as the name. 03:15 Sofia is 00:15 or 01:15 UTC, so
# the date is the same either way; UTC just means DST never makes two nights
# share a folder or a night skip one.
object="gs://$BUCKET/playerz/$(date -u +%Y/%m/%d)/playerz-$now_utc.dump"
local_dump="$work/playerz-$now_utc.dump"

step="pg_dump"
# -Fc is compressed (zlib) and is what pg_restore needs for selective and
# parallel restore. `--no-password`: if trust ever goes away this fails
# immediately instead of hanging on a prompt nobody will answer.
docker exec "$CONTAINER" pg_dump -Fc --no-password -U "$user" -d "$db" >"$local_dump"

step="check local dump"
size="$(stat -c %s "$local_dump")"
[ "$size" -gt 0 ] || { log "FAILED: pg_dump wrote 0 bytes"; exit 1; }
toc_local="$(docker exec -i "$CONTAINER" pg_restore --list <"$local_dump" | grep -vc '^;')"

step="upload to $object"
gcloud storage cp --quiet "$local_dump" "$object"

step="verify uploaded object"
remote_size="$(gcloud storage objects describe "$object" --format='value(size)')"
[ "$remote_size" = "$size" ] || { log "FAILED: $object is $remote_size bytes, local dump is $size"; exit 1; }
gcloud storage cp --quiet "$object" "$work/roundtrip.dump"
cmp -s "$local_dump" "$work/roundtrip.dump" || { log "FAILED: downloaded $object differs from the local dump"; exit 1; }
toc_remote="$(docker exec -i "$CONTAINER" pg_restore --list <"$work/roundtrip.dump" | grep -vc '^;')"

log "OK $object size=${size}B toc_entries=$toc_remote (local $toc_local) db=$db"
