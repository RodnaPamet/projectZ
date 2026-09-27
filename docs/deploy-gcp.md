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
cd /opt/playerz/repo && sudo git fetch --all && sudo git reset --hard origin/main
sudo nice -n 10 docker build --build-arg SKIP_ENV_VALIDATION=1 -t playerz:local .

# Migrations run from the BUILDER stage, which still has node_modules and npx —
# the runtime image deliberately has neither.
sudo docker build --target builder -t playerz-migrator:local .
sudo docker run --rm --network playerz_internal --env-file /opt/playerz/.env -w /app \
  playerz-migrator:local npx prisma migrate deploy

cd /opt/playerz && sudo docker compose -f docker-compose.prod.yml up -d --force-recreate app
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

`playerz.35-187-80-26.sslip.io`. **playerz.bg is not in DNS** — no A record, no
NS, no SOA. Caddy cannot obtain a certificate for a name that does not resolve
here, and listing one makes it retry and log failures forever.

When the domain is registered and points at `35.187.80.26`, add it to the first
line of the site block and reload. Caddy provisions the certificate itself.

## Verifying

```bash
curl -s https://playerz.35-187-80-26.sslip.io/api/ready
curl -s -o /dev/null -w '%{http_code}\n' https://35-187-80-26.sslip.io/   # agrent, still 200
```

Check agrent every time. It is the whole risk of sharing a box.

`/api/health` is liveness and touches nothing — that is why the container
healthcheck uses it. `/api/ready` checks Postgres and Redis and 503s when
either is down, and also reports which sign-in methods and push channels are
actually configured.

## Not done yet

- **No backups.** The Postgres volume is a Docker volume on one VM. See #218.
- **No OAuth credentials.** `/api/ready` reports `google: disabled,
microsoft: disabled`, and the web login page offers nothing else — so nobody
  can sign in until `GOOGLE_CLIENT_ID/SECRET` and `MICROSOFT_CLIENT_ID/SECRET/
TENANT_ID` are set and the redirect URI
  `https://<host>/api/auth/callback/<provider>` is registered.
- **No data.** The database has the schema and nothing else.
