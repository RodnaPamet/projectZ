#!/usr/bin/env bash
# Email the owner before the shared VM's disk fills (#440).
#
# On 2026-10-07 the agrent VM's disk reached 100%: playerz-db PANICked on a
# checkpoint and agrent's Redis failed its saves. Nothing had said the disk was
# filling. This runs from cron every 15 minutes (docs/deploy-gcp.md, "Disk
# alerts") and emails ALERT_EMAIL when:
#
#   disk   `df /` is above DISK_ALERT_THRESHOLD percent (80)
#   logs   the last DISK_ALERT_LOG_SINCE (20m) of playerz-db, playerz-redis or
#          playerz-pgbouncer holds PANIC, "No space left" or MISCONF, the lines
#          a full disk writes
#
# At most one email per condition every DISK_ALERT_REPEAT_SECONDS (6 hours),
# remembered in a state file, and one "OK again" when the condition clears.
#
# ═══ THE KEY ═══
#
# Resend's HTTP API, with RESEND_API_KEY from /opt/playerz/.env (the app's own
# key, src/lib/email/provider.ts), to ALERT_EMAIL from the same file. The file
# is read line by line, never sourced: it is the app's, and sourcing would run
# it. The key is never printed and never on a command line: `printf` is a
# shell builtin, and curl reads the header from its stdin (`-H @-`).
#
# ═══ NOTHING MACHINE-WIDE ═══
#
# The VM is agrent's too. This reads `df /` and playerz's own containers'
# logs, writes only under DISK_ALERT_STATE_DIR, and changes no setting.
#
# ═══ TESTING ═══
#
# `--dry-run` prints what it would send and writes nothing. Every input can be
# overridden from the environment (tests/unit/ops/disk-alert.test.ts does):
# DISK_ALERT_ENV_FILE, _STATE_DIR, _THRESHOLD, _LOG_SINCE, _REPEAT_SECONDS,
# _CONTAINERS, _DF_CMD, _DOCKER_CMD, _CURL and _NOW.
#
# Written for bash 3.2 as well as 5: no mapfile, no associative arrays.
set -Eeuo pipefail

DRY_RUN=0
case "${1:-}" in
  --dry-run) DRY_RUN=1 ;;
  '') ;;
  *)
    echo "usage: playerz-disk-alert [--dry-run]" >&2
    exit 2
    ;;
esac

ENV_FILE="${DISK_ALERT_ENV_FILE:-/opt/playerz/.env}"
STATE_DIR="${DISK_ALERT_STATE_DIR:-/var/lib/playerz-disk-alert}"
THRESHOLD="${DISK_ALERT_THRESHOLD:-80}"
LOG_SINCE="${DISK_ALERT_LOG_SINCE:-20m}"
REPEAT_SECONDS="${DISK_ALERT_REPEAT_SECONDS:-21600}"
CONTAINERS="${DISK_ALERT_CONTAINERS:-playerz-db playerz-redis playerz-pgbouncer}"
read -r -a DF_CMD <<<"${DISK_ALERT_DF_CMD:-df -P /}"
read -r -a DOCKER_CMD <<<"${DISK_ALERT_DOCKER_CMD:-docker}"
CURL="${DISK_ALERT_CURL:-curl}"
NOW="${DISK_ALERT_NOW:-$(date +%s)}"
HOST="$(hostname)"
PATTERN='PANIC|No space left|MISCONF'

log() { echo "playerz-disk-alert: $*"; }

# One value from the env file: the last `NAME=` line, one pair of quotes off.
env_value() {
  local line
  line="$(grep -E "^$1=" "$ENV_FILE" 2>/dev/null | tail -n 1 || true)"
  line="${line#*=}"
  case "$line" in
    \"*\" | \'*\') line="${line:1:${#line}-2}" ;;
  esac
  printf '%s' "$line"
}

# A JSON string's inside: backslashes and quotes escaped, tabs and newlines as
# \t and \n, every other control character dropped (a log line can hold any).
json_escape() {
  local tab
  tab="$(printf '\t')"
  printf '%s' "$1" |
    LC_ALL=C tr -d '\000-\010\013\014\015\016-\037' |
    sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e "s/${tab}/\\\\t/g" |
    awk 'NR > 1 { printf "%s", "\\n" } { printf "%s", $0 }'
}

KEY=''
ALERT_EMAIL=''
FROM=''
if [ -r "$ENV_FILE" ]; then
  KEY="$(env_value RESEND_API_KEY)"
  ALERT_EMAIL="$(env_value ALERT_EMAIL)"
  FROM="$(env_value ALERT_FROM)"
  [ -n "$FROM" ] || FROM="$(env_value EMAIL_FROM)"
fi
[ -n "$FROM" ] || FROM='playerz.bg <noreply@playerz.bg>'

# Send one email; prints why when it cannot.
send() {
  local subject="$1" text="$2" body status
  if [ "$DRY_RUN" = 1 ]; then
    log "dry run: would email ${ALERT_EMAIL:-<ALERT_EMAIL unset>}: $subject"
    printf '%s\n' "$text" | sed 's/^/    /'
    return 0
  fi
  if [ -z "$KEY" ]; then
    log "FAILED: RESEND_API_KEY is not set in $ENV_FILE; not sent: $subject"
    return 1
  fi
  if [ -z "$ALERT_EMAIL" ]; then
    log "FAILED: ALERT_EMAIL is not set in $ENV_FILE; not sent: $subject"
    return 1
  fi
  body="$(mktemp "$STATE_DIR/mail.XXXXXX")"
  printf '{"from":"%s","to":["%s"],"subject":"%s","text":"%s"}' \
    "$(json_escape "$FROM")" "$(json_escape "$ALERT_EMAIL")" \
    "$(json_escape "$subject")" "$(json_escape "$text")" >"$body"
  status="$(printf 'Authorization: Bearer %s\n' "$KEY" |
    "$CURL" -sS -o /dev/null -w '%{http_code}' --max-time 20 \
      -X POST https://api.resend.com/emails \
      -H @- -H 'Content-Type: application/json' --data-binary "@$body")" || status='no answer'
  rm -f "$body"
  case "$status" in
    2??)
      log "sent: $subject"
      return 0
      ;;
    *)
      log "FAILED: Resend answered $status; not sent: $subject"
      return 1
      ;;
  esac
}

failed=0

# One condition: alert while it holds (once per REPEAT_SECONDS), "OK again"
# once when it stops.
check() {
  local name="$1" firing="$2" subject="$3" ok_subject="$4" detail="$5"
  local state="$STATE_DIR/$name.alerted" last=0
  if [ "$firing" = 1 ]; then
    if [ -f "$state" ]; then last="$(cat "$state")"; fi
    case "$last" in '' | *[!0-9]*) last=0 ;; esac
    if [ $((NOW - last)) -lt "$REPEAT_SECONDS" ]; then
      log "$name: still firing; emailed $(((NOW - last) / 60)) min ago"
      return 0
    fi
    if send "[playerz] $subject" "$detail"; then
      [ "$DRY_RUN" = 1 ] || echo "$NOW" >"$state"
    else
      failed=1
    fi
  elif [ -f "$state" ]; then
    if send "[playerz] OK again: $ok_subject" "$detail"; then
      [ "$DRY_RUN" = 1 ] || rm -f "$state"
    else
      failed=1
    fi
  fi
}

umask 077
[ "$DRY_RUN" = 1 ] || mkdir -p "$STATE_DIR"

# ── The disk ──
df_out="$("${DF_CMD[@]}")" || {
  log "FAILED: ${DF_CMD[*]} did not answer"
  exit 1
}
used="$(printf '%s\n' "$df_out" | awk 'NR == 2 { sub(/%$/, "", $5); print $5 }')"
case "$used" in
  '' | *[!0-9]*)
    log "FAILED: no use% in: $df_out"
    exit 1
    ;;
esac
firing=0
[ "$used" -le "$THRESHOLD" ] || firing=1
check disk "$firing" \
  "the disk of $HOST is ${used}% full (the alert is above ${THRESHOLD}%)" \
  "the disk of $HOST is ${used}% full" \
  "$(printf '%s\n\n%s' "$df_out" \
    'What fills it, and the prune that is safe for agrent: docs/deploy-gcp.md, "Disk alerts".')"

# ── The containers' disk errors ──
for c in $CONTAINERS; do
  if ! out="$("${DOCKER_CMD[@]}" logs --since "$LOG_SINCE" "$c" 2>&1)"; then
    # A container that is not there is not a disk error; its state is kept.
    log "$c: no logs ($(printf '%s' "$out" | head -n 1))"
    continue
  fi
  hits="$(printf '%s\n' "$out" | grep -E "$PATTERN" | tail -n 20 || true)"
  firing=0
  [ -z "$hits" ] || firing=1
  check "logs-$c" "$firing" \
    "$c on $HOST logged a disk error (PANIC, No space left or MISCONF)" \
    "$c on $HOST logged no disk error in the last $LOG_SINCE" \
    "${hits:-No PANIC, No space left or MISCONF in the last $LOG_SINCE.}"
done

[ "$DRY_RUN" = 0 ] || log "dry run: nothing was sent and no state was written"
exit "$failed"
