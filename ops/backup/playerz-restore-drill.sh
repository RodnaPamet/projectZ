#!/usr/bin/env bash
# Restore drill for the nightly pg_dump (#218). An untested backup is a
# belief, not a capability — this turns it into one, on demand.
#
#   sudo /usr/local/sbin/playerz-restore-drill                 # newest dump
#   sudo /usr/local/sbin/playerz-restore-drill gs://.../x.dump # a given one
#
# Restores into a SCRATCH database inside `playerz-db`, compares exact row
# counts for every table against production, and drops the scratch database
# on every exit, pass or fail. It never writes to production: the target
# name is fixed, and the script refuses outright if it equals POSTGRES_DB.
#
# ═══ ROW COUNTS ARE COMPARED AGAINST PRODUCTION *NOW* ═══
#
# Not against production at dump time, which no longer exists. On a quiet
# box they match exactly. A table that took writes since the dump will
# differ by those writes; the drill reports it as a MISMATCH rather than
# guessing, so read the diff before panicking. Drill against a fresh dump
# (`systemctl start playerz-db-backup` first) to keep that window small.
#
# Same credentials and same no-secrets rule as playerz-db-backup.sh.
set -Eeuo pipefail

BUCKET="${PLAYERZ_BACKUP_BUCKET:-playerz-db-backups-hazel}"
CONTAINER="${PLAYERZ_DB_CONTAINER:-playerz-db}"
KEY_FILE="${PLAYERZ_BACKUP_KEY_FILE:-/etc/playerz-db-backup/sa-key.json}"
SCRATCH_DB="playerz_restore_drill"

export CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE="$KEY_FILE"
export CLOUDSDK_CONFIG=/var/lib/playerz-db-backup/gcloud
export CLOUDSDK_CORE_DISABLE_PROMPTS=1

log() { echo "playerz-restore-drill: $*"; }
psql_in() { docker exec -i "$CONTAINER" psql -X -q -v ON_ERROR_STOP=1 --no-password -U "$user" "$@"; }

umask 077
mkdir -p "$CLOUDSDK_CONFIG"
work="$(mktemp -d)"

db="$(docker exec "$CONTAINER" printenv POSTGRES_DB)"
user="$(docker exec "$CONTAINER" printenv POSTGRES_USER)"
if [ "$SCRATCH_DB" = "$db" ]; then
  log "REFUSING: scratch database name equals production ($db)"
  exit 1
fi

cleanup() {
  psql_in -d postgres -c "DROP DATABASE IF EXISTS $SCRATCH_DB WITH (FORCE);" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

object="${1:-}"
if [ -z "$object" ]; then
  # Object names sort by date because the path and the timestamp are both
  # zero-padded UTC, so the lexically last one is the newest.
  object="$(gcloud storage ls "gs://$BUCKET/playerz/**" | grep '\.dump$' | sort | tail -n 1)"
  [ -n "$object" ] || { log "FAILED: no dumps under gs://$BUCKET/playerz/"; exit 1; }
fi
log "restoring $object into $SCRATCH_DB"
gcloud storage cp --quiet "$object" "$work/drill.dump"

# template0, not the default template1: the dump carries its own
# CREATE EXTENSION statements (postgis, btree_gist, ...), and anything already
# in the template would collide with them.
psql_in -d postgres -c "DROP DATABASE IF EXISTS $SCRATCH_DB WITH (FORCE);" >/dev/null
psql_in -d postgres -c "CREATE DATABASE $SCRATCH_DB TEMPLATE template0;" >/dev/null

# --exit-on-error: a restore that "mostly worked" is the failure this drill is
# here to catch. --single-transaction makes it all-or-nothing.
docker exec -i "$CONTAINER" pg_restore --no-password -U "$user" -d "$SCRATCH_DB" \
  --exit-on-error --single-transaction <"$work/drill.dump"

# Exact count(*) of every base table outside the system schemas, as
# `schema.table<TAB>count`. query_to_xml runs one dynamic count per row
# without needing a function in the database. Run as the owner role, which is
# a superuser, so RLS cannot hide rows from either side of the comparison.
counts_sql="
SELECT format('%s.%s', table_schema, table_name) || chr(9) ||
       (xpath('/row/c/text()',
              query_to_xml(format('SELECT count(*) AS c FROM %I.%I', table_schema, table_name),
                           false, true, '')))[1]::text
FROM information_schema.tables
WHERE table_type = 'BASE TABLE'
  AND table_schema NOT IN ('pg_catalog', 'information_schema')
ORDER BY 1;"

psql_in -d "$db" -At -c "$counts_sql" >"$work/prod.tsv"
psql_in -d "$SCRATCH_DB" -At -c "$counts_sql" >"$work/drill.tsv"

tables="$(wc -l <"$work/prod.tsv" | tr -d ' ')"
rows="$(awk -F'\t' '{s += $2} END {print s + 0}' "$work/prod.tsv")"

if diff -u "$work/prod.tsv" "$work/drill.tsv" >"$work/diff.txt"; then
  log "OK $tables tables, $rows rows, every count matches production"
  # The full table so the journal (or your terminal) keeps the evidence.
  # `paste`, not `join`: the files are identical line for line (diff just
  # said so), and join would want them sorted in ITS locale, not Postgres's.
  paste "$work/prod.tsv" "$work/drill.tsv" |
    awk -F'\t' '{printf "  %-50s prod=%-8s restored=%s\n", $1, $2, $4}'
else
  log "MISMATCH between production (-) and the restored dump (+):"
  cat "$work/diff.txt"
  exit 1
fi
