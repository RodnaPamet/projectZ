#!/bin/bash
#
# Put a real domain in front of playerz.bg, once its DNS actually points here.
#
# Run ON the VM, as root:  sudo bash add-domain.sh playerz.bg
#
# ═══ WHY THE DNS CHECK IS NOT OPTIONAL ═══
#
# Caddy asks Let's Encrypt for a certificate for every name in a site block. A
# name that does not resolve to this host fails the HTTP-01 challenge, and Caddy
# then retries — with backoff, forever, logging each failure. Worse, repeated
# failures count against the Let's Encrypt rate limit for that domain (5 per
# hostname per hour), so a premature attempt can lock out the real one for an
# hour after DNS is finally correct.
#
# So: resolve first, edit second.
set -euo pipefail

DOMAIN="${1:?usage: add-domain.sh <domain>}"
IP=35.187.80.26
CADDY=/opt/agrent/Caddyfile
SITE=/opt/playerz/Caddyfile.playerz
ENVF=/opt/playerz/.env

for name in "$DOMAIN" "www.$DOMAIN"; do
  got=$(getent ahostsv4 "$name" | awk '{print $1}' | sort -u | tr '\n' ' ')
  echo "$name -> ${got:-(nothing)}"
  case " $got " in
    *" $IP "*) ;;
    *) echo "REFUSING: $name does not resolve to $IP yet."; exit 1;;
  esac
done

if grep -q "^$DOMAIN\b\|[ ,]$DOMAIN[ ,{]" "$CADDY"; then
  echo "$DOMAIN already in the Caddyfile — nothing to do"; exit 0
fi

BAK="$CADDY.bak.$(date +%Y%m%d-%H%M%S)"
cp -a "$CADDY" "$BAK"; echo "backup: $BAK"
restore () { echo "!! restoring $BAK"; cp -a "$BAK" "$CADDY"; }

# The apex joins the site block; the sslip.io name stays alongside it so
# nothing breaks mid-transition. `www` gets its own block and REDIRECTS rather
# than serving: two hostnames serving the same app means two cookie jars, and a
# session started on one is invisible to the other.
for f in "$CADDY" "$SITE"; do
  sed -i -E "s#^playerz\.35-187-80-26\.sslip\.io \{#$DOMAIN, playerz.35-187-80-26.sslip.io {#" "$f"
done

printf '\nwww.%s {\n\tredir https://%s{uri} permanent\n}\n' "$DOMAIN" "$DOMAIN" | tee -a "$SITE" >> "$CADDY"

if ! docker exec agrent-caddy caddy validate --adapter caddyfile --config /etc/caddy/Caddyfile; then
  restore; echo "VALIDATE FAILED"; exit 1
fi
if ! docker exec agrent-caddy caddy reload --adapter caddyfile --config /etc/caddy/Caddyfile; then
  restore
  docker exec agrent-caddy caddy reload --adapter caddyfile --config /etc/caddy/Caddyfile || true
  echo "RELOAD FAILED"; exit 1
fi

# NEXTAUTH_URL is what next-auth builds every callback and redirect from. Leave
# it on sslip.io and the OAuth round trip comes back to the wrong host.
cp -a "$ENVF" "$ENVF.bak.$(date +%s)"
sed -i -E "s#^NEXTAUTH_URL=.*#NEXTAUTH_URL=https://$DOMAIN#" "$ENVF"
cd /opt/playerz && docker compose -f docker-compose.prod.yml up -d --force-recreate app

echo "done — https://$DOMAIN"
