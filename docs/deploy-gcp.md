# Deploying playerz.bg

playerz.bg runs on the **`agrent` Compute Engine VM** in project
`hazel-design-419410`, zone `europe-west1-b`, external IP `35.187.80.26`.

It is a co-tenant, not a guest. Its Postgres, PgBouncer and Redis are its own
containers in their own compose project on their own network. The **only**
thing shared with agrent is Caddy, because only one process can bind 80/443.

## Why this box and not Fly

Fly was provisioned and then destroyed. Two things decided it:

- The trial organisation could not create a Redis add-on at all, and the app
  refuses to boot in production without `REDIS_URL` — the rate limiter's
  fallback is an in-memory `Map`, which is per-process, so `login:<ip>` would
  mean one budget per machine rather than one budget.
- The VM was already paid for and idle: **16 GB RAM with 1.5 GB in use, 79 GB
  disk at 17%**. A second small Postgres and a second small app fit with room
  to spare.

`docs/deploy-fly.md` and `fly.toml` are gone with it. A committed config for a
platform nothing runs on is worse than no config: someone will follow it.

## Layout on the box

```
/opt/playerz/
  .env                      # chmod 600, generated ON the box, never in git
  docker-compose.prod.yml   # copied from deploy/ in this repo
  Caddyfile.playerz         # copied from deploy/ in this repo
  repo/                     # a clone, used only as a Docker build context
```

Compose project `playerz` — separate from `agrent`, so `docker compose down`
here cannot touch a production app that was working.

| Container           | Purpose                                                                                                                                                                             |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `playerz-db`        | PostGIS 16-3.4. Not plain Postgres: `/venues/near` needs PostGIS and the booking exclusion constraint needs `btree_gist`.                                                           |
| `playerz-pgbouncer` | Transaction pooling. `SET LOCAL ROLE` is transaction-scoped, so transaction mode is safe; session mode would exhaust the pool and statement mode would break the bindings outright. |
| `playerz-redis`     | Sessions, rate-limit counters, job queue. Password-protected.                                                                                                                       |
| `playerz-app`       | The Next.js image. On `playerz_internal` **and** `agrent_internal`.                                                                                                                 |

## ═══ EVERY HOSTNAME IS A CONTAINER NAME ═══

**This is the one thing that will bite you.** agrent's compose uses the service
names `db`, `pgbouncer` and `redis`. So does ours. Because `playerz-app` joins
`agrent_internal` to reach Caddy, those names resolve _there_:

```
db        -> 172.18.0.5   (agrent-db)
pgbouncer -> 172.18.0.3   (agrent-pgbouncer)
redis     -> 172.18.0.2   (agrent-redis)
```

The first boot dialled agrent's Postgres and agrent's Redis. Both refused it —
`SASL authentication failed`, `NOAUTH Authentication required` — and that
refusal is the only reason it was a near miss rather than an incident.

`container_name` is unique per host. Use `playerz-db`, `playerz-pgbouncer`,
`playerz-redis` in every URL.

## The database roles

Two, and the split is the whole point of P24:

| URL                   | Role                         | Used for                         |
| --------------------- | ---------------------------- | -------------------------------- |
| `DIRECT_DATABASE_URL` | `playerz` (owner, superuser) | `prisma migrate deploy`, seeding |
| `DATABASE_URL`        | `playerz_app`                | everything the app does          |

`playerz_app` is `LOGIN NOINHERIT` with no password as shipped — a password in
a migration would be a password in git. Set it out of band, after
`migrate deploy` creates the role:

```bash
set -a; . /opt/playerz/.env; set +a
printf "\\set pw '%s'\nALTER ROLE playerz_app PASSWORD :'pw';\n" "$PLAYERZ_APP_PASSWORD" |
  docker exec -i playerz-db psql -U playerz -d playerz_production -v ON_ERROR_STOP=1
```

Two things are deliberate here.

The password goes in on **stdin as a psql variable**, so psql quotes it and
nothing about it depends on the shell — and it never reaches a command line,
where `ps` on a shared host would show it.

No `PGPASSWORD` either: this is `psql` inside the container talking to its own
unix socket, and the image's `initdb` sets `trust` for local connections.
Verified — `inet_server_addr()` is null, so it really is the socket.

`assertLeastPrivilegeConnection` verifies this at boot and refuses to start if
`DATABASE_URL` turns out to be a superuser or `BYPASSRLS`. A successful start
logs `runtime database role verified as least-privileged`.

## Deploying a new version

There is no registry. The image is built on the box from a clone.

```bash
# Keep the running image as the way back. Migrations here have been additive, so
# the previous image runs against the new schema; re-tag and recreate to roll back.
sudo docker tag playerz:local playerz:rollback-$(date +%s)

cd /opt/playerz/repo && sudo git fetch --all && sudo git reset --hard origin/main
sudo nice -n 10 docker build --build-arg SKIP_ENV_VALIDATION=1 -t playerz:local .

# Migrations run from the BUILDER stage, which still has node_modules and npx —
# the runtime image deliberately has neither.
sudo docker build --target builder -t playerz-migrator:local .
sudo docker run --rm --network playerz_internal --env-file /opt/playerz/.env -w /app \
  playerz-migrator:local npx prisma migrate deploy

cd /opt/playerz && sudo docker compose -f docker-compose.prod.yml up -d --force-recreate playerz-app
```

`SKIP_ENV_VALIDATION=1` is for the **build** only. Next imports every route
module to collect metadata, and `src/env.ts` would refuse at import time for
want of secrets that belong in the runtime environment, not the image.

## Caddy

agrent's `Caddyfile` at `/opt/agrent/Caddyfile` is bind-mounted into
`agrent-caddy`. The playerz site block lives in `deploy/Caddyfile.playerz` in
this repo and is **appended** to it.

Back up, validate, then **reload** — never restart. A reload swaps the config
on a running server; a restart drops agrent's traffic to fix ours.

```bash
cp -a /opt/agrent/Caddyfile /opt/agrent/Caddyfile.bak.$(date +%Y%m%d-%H%M%S)
cat /opt/playerz/Caddyfile.playerz >> /opt/agrent/Caddyfile
docker exec agrent-caddy caddy validate --adapter caddyfile --config /etc/caddy/Caddyfile
docker exec agrent-caddy caddy reload   --adapter caddyfile --config /etc/caddy/Caddyfile
```

If validate fails, restore the backup before doing anything else.

### The hostname

Serving host: **`app.playerz.bg`** (`A 35.187.80.26`). As of 2026-09-29 it
serves `/api/ready` over HTTPS with a valid certificate — `curl` without `-k`
succeeds. `playerz.35-187-80-26.sslip.io` stays in the site block as a way in if
DNS ever goes wrong.

Any NEW name must resolve here BEFORE Caddy is told about it. Caddy cannot obtain
a certificate for a name that does not resolve to this box; listing one anyway
makes it retry forever _and_ burns Let's Encrypt's
five-failures-per-hostname-per-hour budget, locking out the real attempt for an
hour after DNS is finally right. (This is what held `app.playerz.bg` up at
first: the `playerz.bg` delegation to `ns1/ns2.jumphosting01.com` existed before
the zone behind it did, and those nameservers answered REFUSED.)

`deploy/add-domain.sh` does the whole switch for a name, and refuses if it does
not resolve:

```bash
sudo bash /opt/playerz/add-domain.sh app.playerz.bg
```

It adds the name beside the sslip.io one (which stays, as a way in if DNS goes
wrong), validates, reloads, moves `NEXTAUTH_URL`, and recreates the app. Names
given after the first get a `redir` block rather than joining the site block —
two hostnames serving the same app means two cookie jars.

## Scheduled jobs

Three routes under `/api/cron` do work nothing else triggers, and each refuses
to run (503) until `CRON_SECRET` is set:

| Route                           | Cadence | Without it                                                                 |
| ------------------------------- | ------- | -------------------------------------------------------------------------- |
| `release-expired-bookings`      | 60 s    | an abandoned checkout holds its court for ever, and keeps the credit spent |
| `complete-ended-bookings`       | 60 s    | no booking ever becomes COMPLETED, so nobody can ever leave a review       |
| `warn-expiring-platform-grants` | daily   | a platform grant lapses mid-incident with no warning                       |

`ops/sweep.compose.yml` runs all three as small `alpine` loops. It is an
overlay on `docker-compose.prod.yml`, so copy it beside that file and name
both:

```bash
# once: add CRON_SECRET to /opt/playerz/.env (openssl rand -base64 32)
cd /opt/playerz && sudo docker compose -f docker-compose.prod.yml -f sweep.compose.yml up -d
```

Until #247 the overlay was not a valid compose project against this file —
it named a service `app` that #230 had renamed `playerz-app` — so none of the
three ran before 2026-09-29.

**Running since 2026-09-29 17:45 UTC** (#249): `playerz-booking-sweep`,
`playerz-booking-complete` and `playerz-grant-expiry-warn`. They are silent when
there is nothing to do, so silence alone proves nothing. Prove it from inside a
sweep container, with its own secret (expanded in the container, never on your
command line), and with a negative control:

```bash
sudo docker exec playerz-booking-complete sh -c \
  'wget -q -O- --post-data="" --header="x-cron-secret: $CRON_SECRET" http://playerz-app:3000/api/cron/complete-ended-bookings'
# → {"scanned":0,"completed":0,"truncated":false}
sudo docker exec playerz-booking-complete sh -c \
  'wget -S -q -O- --post-data="" http://playerz-app:3000/api/cron/complete-ended-bookings 2>&1 | grep HTTP/'
# → HTTP/1.1 401 Unauthorized
```

## Verifying

```bash
curl -s https://app.playerz.bg/api/ready
curl -s -o /dev/null -w '%{http_code}\n' https://35-187-80-26.sslip.io/   # agrent: must not change
```

Check agrent every time. It is the whole risk of sharing a box. Record its
status code BEFORE you start and compare after — do not compare against a fixed
number: on 2026-09-29 it answered `307`, not the `200` this section used to say.

`/api/health` is liveness and touches nothing — that is why the container
healthcheck uses it. `/api/ready` checks Postgres and Redis and 503s when
either is down, and also reports which sign-in methods and push channels are
actually configured.

## Not done yet

- **No backups.** The Postgres volume is a Docker volume on one VM. See #218.
- **Microsoft sign-in not configured.** `/api/ready` reports
  `google: configured, microsoft: disabled` (2026-09-29). To enable it, set
  `MICROSOFT_CLIENT_ID/SECRET/TENANT_ID` and register the callback:

  | Provider        | Callback                                            |
  | --------------- | --------------------------------------------------- |
  | Google (live)   | `https://app.playerz.bg/api/auth/callback/google`   |
  | Microsoft Entra | `https://app.playerz.bg/api/auth/callback/azure-ad` |

  `azure-ad`, not `microsoft-entra-id` — this is next-auth **v4**, and the
  provider id is what the callback path is built from.

- **Almost no data.** As of 2026-09-29: one club (`demo-sofia`), two accounts,
  zero bookings.

## Shared with agrent

- **`ANTHROPIC_API_KEY`** in `/opt/playerz/.env` was copied server-side from
  `/opt/agrent/.env` on 2026-09-29 (review moderation, #257). The two products
  share one key: rotating it means updating **both** files and recreating both
  apps.
- The VM, Caddy (reload, never restart) and the `agrent_internal` network — see
  above.
