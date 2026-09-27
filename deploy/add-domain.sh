#!/bin/bash
#
# Put a real hostname in front of playerz.bg.
#
#   sudo bash add-domain.sh app.playerz.bg
#   sudo bash add-domain.sh app.playerz.bg www.playerz.bg   # second one redirects
#
# The FIRST name is canonical: it joins the site block and becomes NEXTAUTH_URL.
# Every later name gets its own block that redirects to the canonical one, and
# does NOT serve the app — two hostnames serving the same app means two cookie
# jars, and a session started on one is invisible to the other.
#
# The sslip.io name stays in the site block alongside, so nothing breaks
# mid-transition and there is always a way in if DNS goes wrong.
#
# ═══ WHY THE DNS CHECK IS NOT OPTIONAL ═══
#
# Caddy asks Let's Encrypt for a certificate for every name in a site block. A
# name that does not resolve to this host fails the HTTP-01 challenge, and Caddy
# then retries — with backoff, forever, logging each failure. Worse, repeated
# failures count against the Let's Encrypt rate limit for that hostname (5 per
# hour), so a premature attempt can lock out the real one for an hour after DNS
# is finally correct.
#
# So: resolve first, edit second.
set -euo pipefail

[ $# -ge 1 ] || { echo "usage: add-domain.sh <canonical-host> [redirect-host ...]"; exit 2; }
CANON="$1"; shift
REDIRS=("$@")

IP=35.187.80.26
CADDY=/opt/agrent/Caddyfile
SITE=/opt/playerz/Caddyfile.playerz
ENVF=/opt/playerz/.env

for name in "$CANON" "${REDIRS[@]+"${REDIRS[@]}"}"; do
  got=$(getent ahostsv4 "$name" | awk '{print $1}' | sort -u | tr '\n' ' ')
  echo "$name -> ${got:-(nothing)}"
  case " $got " in
    *" $IP "*) ;;
    *) echo "REFUSING: $name does not resolve to $IP yet."; exit 1;;
  esac
done

if grep -qF "$CANON" "$CADDY"; then
  echo "$CANON already in the Caddyfile — nothing to do"; exit 0
fi

BAK="$CADDY.bak.$(date +%Y%m%d-%H%M%S)"
cp -a "$CADDY" "$BAK"; echo "backup: $BAK"
restore () { echo "!! restoring $BAK"; cp -a "$BAK" "$CADDY"; }

for f in "$CADDY" "$SITE"; do
  # Matches the hostname followed by a space, NOT the opening brace: `{` starts
  # an interval expression in ERE, and BSD sed rejects the pattern outright
  # ("RE error: braces not balanced"). GNU sed on the box accepts it, which is
  # exactly how that kind of bug reaches production unnoticed.
  sed -i -E "s#^playerz\.35-187-80-26\.sslip\.io #$CANON, playerz.35-187-80-26.sslip.io #" "$f"
done

for name in "${REDIRS[@]+"${REDIRS[@]}"}"; do
  printf '\n%s {\n\tredir https://%s{uri} permanent\n}\n' "$name" "$CANON" | tee -a "$SITE" >> "$CADDY"
done

if ! docker exec agrent-caddy caddy validate --adapter caddyfile --config /etc/caddy/Caddyfile; then
  restore; echo "VALIDATE FAILED"; exit 1
fi
if ! docker exec agrent-caddy caddy reload --adapter caddyfile --config /etc/caddy/Caddyfile; then
  restore
  docker exec agrent-caddy caddy reload --adapter caddyfile --config /etc/caddy/Caddyfile || true
  echo "RELOAD FAILED"; exit 1
fi

# NEXTAUTH_URL is what next-auth builds every callback and redirect from. Left
# on sslip.io, the OAuth round trip comes back to the wrong host and sign-in
# fails at the last step — after the user has already consented, which is the
# most confusing place for it to fail.
cp -a "$ENVF" "$ENVF.bak.$(date +%s)"
sed -i -E "s#^NEXTAUTH_URL=.*#NEXTAUTH_URL=https://$CANON#" "$ENVF"
cd /opt/playerz && docker compose -f docker-compose.prod.yml up -d --force-recreate app

echo "done — https://$CANON"
