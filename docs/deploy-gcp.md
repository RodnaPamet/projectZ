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
# The exceptions: p37, and every migration that added an enum value (p51, p54,
# p55, p61, p67: their ROWS, not their schema, #450). Each has a "Rolling back
# past pNN" section below with a park script to run first. The list cannot fall
# behind: tests/guardrails/enum-value-has-rollback-park.test.ts fails the build
# for an enum migration without its scripts, its section and its test.
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

### Rolling back past p37

`20260929190000_p37_account_kinds` (#263) is the first migration that is not
additive. It drops `app_user.lastContext`, which
`20260929150000_user_last_context` added. Every image built between the two
still maps that column, including 4efe8c1, the one deployed on 2026-09-29:

- password sign-in reads a user row with no `select`
  (`src/lib/auth/verify-credentials.ts`), and Prisma names every column it
  maps, so the read fails with `P2022`;
- `/start` reads the column by name.

Put the column back **before** starting the rollback image:

```bash
docker exec -i playerz-db psql -U playerz -d playerz_production -v ON_ERROR_STOP=1 \
  -c 'ALTER TABLE "app_user" ADD COLUMN IF NOT EXISTS "lastContext" TEXT;'
```

The column only remembered which context the old switcher last chose, so
nothing that matters is lost. Leave the rest of p37 in place.

- The `accountKind` column is simply unmapped in the old image.
- The kinds triggers keep refusing mixed accounts. The old image cannot say why
  and fails those writes as errors, but they are the writes the owner ruled out.

### Rolling back past p51

`20261007150000_p51_squash_karting` only adds enum values (`SQUASH`, `KARTING`,
`TRACK`), so the schema is no obstacle: an image built before it runs against
it unchanged. The ROWS that use those values are. Prisma 7 refuses to read an
enum value its client was not generated with, and the whole query fails:

```
PrismaClientKnownRequestError: Value 'SQUASH' not found in enum 'SportType'
```

Measured against the pre-p51 client, not inferred. `/venues` reads every court
of the venues on its page and its filters read the sport of every live court,
so one squash court at a public venue fails the previous image's venue index,
for everybody. A player who picked squash on their profile fails `/me`; a
squash or karting booking fails its player's bookings and the club's diary.

So before starting the previous image, park those rows. If it reports a table
it does not handle, something else wrote a new value: stop and look before
rolling back.

```bash
docker exec -i playerz-db psql -U playerz -d playerz_production -v ON_ERROR_STOP=1 \
  < /opt/playerz/repo/deploy/rollback/p51-park.sql
```

Parked, a squash or karting court is archived (off the public pages, not
bookable, its bookings kept) and reads as a tennis court in the previous image;
its name still says what it is. Squash and karting profile levels are set
aside. Tell the two pilot clubs their court is off the app until the roll
forward. After rolling forward again, with the p51 image serving:

```bash
docker exec -i playerz-db psql -U playerz -d playerz_production -v ON_ERROR_STOP=1 \
  < /opt/playerz/repo/deploy/rollback/p51-unpark.sql
```

Until the pilot clubs are onboarded and a player picks squash, nothing uses the
new values and the park finds nothing to do; it is still the safe step. On
staging, the same with `playerz_staging`.

### Rolling back past p54

`20261010120000_p54_messaging` (#375) adds the enum value `CLUB` to
`ConversationType`, the conversations between a player and a club. The images
before it never read a conversation, so nothing breaks today; the park is the
same precaution as p51's, for the first rollback image that does:

```bash
docker exec -i playerz-db psql -U playerz -d playerz_production -v ON_ERROR_STOP=1 \
  < /opt/playerz/repo/deploy/rollback/p54-park.sql
```

It relabels each club conversation `VENUE_CHANNEL` and remembers it. After
rolling forward again, with the p54 image serving:

```bash
docker exec -i playerz-db psql -U playerz -d playerz_production -v ON_ERROR_STOP=1 \
  < /opt/playerz/repo/deploy/rollback/p54-unpark.sql
```

The rest of p54 stays: its columns are new and unmapped in the old image, and
its row security only narrows who reads a conversation.

### Rolling back past p55

`20261010150000_p55_messaging_reports` (#375) adds `CONVERSATION` to
`ModerationSubject`: a report about a whole conversation. Park those reports
and their cases before starting the previous image:

```bash
docker exec -i playerz-db psql -U playerz -d playerz_production -v ON_ERROR_STOP=1 \
  < /opt/playerz/repo/deploy/rollback/p55-park.sql
```

and give them back after rolling forward again, with the p55 image serving:

```bash
docker exec -i playerz-db psql -U playerz -d playerz_production -v ON_ERROR_STOP=1 \
  < /opt/playerz/repo/deploy/rollback/p55-unpark.sql
```

A conversation a moderator closed (`blockedSide` PLATFORM) needs nothing: the
column is text, and the previous image reads it as blocked by the other side.

### Rolling back past p79

`20261014120000_p79_result_notifications` (#575) adds three values to
`NotificationKind`: `RESULT_REPORTED` (to the other side of a reported
result), `RESULT_DISPUTED` (to a club's staff, a rejected result) and
`RESULT_DECIDED` (to the players, the club's decision). The bell reads a
person's notifications on every page, so one such row would break the previous
image's bell. Park those rows before starting the previous image:

```bash
docker exec -i playerz-db psql -U playerz -d playerz_production -v ON_ERROR_STOP=1 \
  < /opt/playerz/repo/deploy/rollback/p79-park.sql
```

and give them back after rolling forward again, with the p79 image serving:

```bash
docker exec -i playerz-db psql -U playerz -d playerz_production -v ON_ERROR_STOP=1 \
  < /opt/playerz/repo/deploy/rollback/p79-unpark.sql
```

Queued and already-sent emails of those kinds are parked and returned with the
bell rows. The rest of p79 stays: the triggers on `match_report` concern a
table the old image does not map. Rolling back past P78 needs nothing more:
`match_report` and `app_user.ratingPublic` are new and unmapped there.

### Rolling back past p74

`20261014070000_p74_coach_reviews` (#551) adds `COACH_REVIEW` to
`ModerationSubject`: a case about a player's review of a coach. The previous
image's moderation queue reads every open case, so one such case would break
the queue. Park them before starting the previous image:

```bash
docker exec -i playerz-db psql -U playerz -d playerz_production -v ON_ERROR_STOP=1 \
  < /opt/playerz/repo/deploy/rollback/p74-park.sql
```

and give them back after rolling forward again, with the p74 image serving:

```bash
docker exec -i playerz-db psql -U playerz -d playerz_production -v ON_ERROR_STOP=1 \
  < /opt/playerz/repo/deploy/rollback/p74-unpark.sql
```

The reviews themselves stay where they are: the previous image never reads
`coach_review` except to delete a deleted account's rows.

### Rolling back past p73

`20261014060000_p73_lesson_notifications` (#550) adds seven values to
`NotificationKind`: three `LESSON_*` (to a coach, about the lessons they teach)
and four `COACH_LINK_*` (a coach asked a club; the club accepted, declined or
ended the link). The bell reads a person's notifications on every page, so one
such row would break the previous image's bell for that coach or that club's
owner. Park those rows before starting the previous image:

```bash
docker exec -i playerz-db psql -U playerz -d playerz_production -v ON_ERROR_STOP=1 \
  < /opt/playerz/repo/deploy/rollback/p73-park.sql
```

and give them back after rolling forward again, with the p73 image serving:

```bash
docker exec -i playerz-db psql -U playerz -d playerz_production -v ON_ERROR_STOP=1 \
  < /opt/playerz/repo/deploy/rollback/p73-unpark.sql
```

Queued and already-sent emails of those kinds are parked and returned with the
bell rows. The rest of p73 stays: `app_user.emailLessonsTaught` is new and
unmapped in the old image, and the email category `lessonsTaught` is read as
text by the old image's drain. While parked, a coach is not told about a new
or cancelled lesson by the old image at all; «Уроци» on their page still
lists them.

### Rolling back past p72

`20261014050000_p72_coach_approval` (#545) adds `COACH_APPROVE` to
`PlatformCapability` and three `COACH_PROFILE_*` values to `NotificationKind`.
The shell reads the signed-in person's live grant on every page, so a grant
that carries `COACH_APPROVE` would lock its holder out of the previous image;
the bell reads a person's notifications on every page. Park them before
starting the previous image:

```bash
docker exec -i playerz-db psql -U playerz -d playerz_production -v ON_ERROR_STOP=1 \
  < /opt/playerz/repo/deploy/rollback/p72-park.sql
```

and give them back after rolling forward again, with the p72 image serving:

```bash
docker exec -i playerz-db psql -U playerz -d playerz_production -v ON_ERROR_STOP=1 \
  < /opt/playerz/repo/deploy/rollback/p72-unpark.sql
```

While parked:

- A grant that carries other capabilities keeps those, and its holder keeps
  working. A grant that carries `COACH_APPROVE` alone is absent until the
  unpark.
- The audit rows written under `COACH_APPROVE` are **not deleted**. They sit,
  whole, in `p72_parked_platform_audit_entry`, and the unpark returns them.
  Do not drop that table by hand.
- The scripts switch the grant-immutability and audit append-only triggers
  off for their own transaction and check, before committing, that both are
  on again. `tests/integration/p72-rollback-park.test.ts` pins that.

The rest of p72 stays: the `'account'` email category is text, which the
previous image's drain sends without knowing it, and the trigger on
`coach_profile` guards a table the previous image never writes.

### Rolling back past p67

`20261014000000_p67_report_game_note` (#526) adds `OPEN_GAME_NOTE` to
`ModerationSubject`: a report about the public note on a game. The previous
image's moderation queue reads every open case, so one such case would break
the queue. Park them before starting the previous image:

```bash
docker exec -i playerz-db psql -U playerz -d playerz_production -v ON_ERROR_STOP=1 \
  < /opt/playerz/repo/deploy/rollback/p67-park.sql
```

and give them back after rolling forward again, with the p67 image serving:

```bash
docker exec -i playerz-db psql -U playerz -d playerz_production -v ON_ERROR_STOP=1 \
  < /opt/playerz/repo/deploy/rollback/p67-unpark.sql
```

### Rolling back past p61

`20261013190000_p61_open_play` (#376) adds five `OPEN_PLAY_*` values to
`NotificationKind`. The bell reads a person's notifications on every page, so
one open-play row would break the previous image's bell for that person. Park
those rows before starting the previous image:

```bash
docker exec -i playerz-db psql -U playerz -d playerz_production -v ON_ERROR_STOP=1 \
  < /opt/playerz/repo/deploy/rollback/p61-park.sql
```

and give them back after rolling forward again, with the p61 image serving:

```bash
docker exec -i playerz-db psql -U playerz -d playerz_production -v ON_ERROR_STOP=1 \
  < /opt/playerz/repo/deploy/rollback/p61-unpark.sql
```

The rest of p61 stays: `open_game`, `open_game_request`,
`booking_participant.noShowAt` and `app_user.emailOpenPlay` are new and
unmapped in the old image. Players an open game accepted are ordinary
`booking_participant` rows and stay on their bookings.

`SKIP_ENV_VALIDATION=1` is for the **build** only. Next imports every route
module to collect metadata, and `src/env.ts` would refuse at import time for
want of secrets that belong in the runtime environment, not the image.

## Staging and the weekly release (#373)

Owner decision Q44: every merge goes to **staging**; **production** gets a release once a week, plus urgent fixes any time. Pilot clubs are not surprised mid-shift.

|           | Staging                                                                                   | Production                                       |
| --------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------ |
| Container | `playerz-staging-app` (`deploy/docker-compose.staging.yml`, project `playerz-staging`)    | `playerz-app`                                    |
| Image tag | `playerz:staging`, rebuilt from `main` after each merge                                   | `playerz:local`, rebuilt from the release SHA    |
| Database  | `playerz_staging` on `playerz-db`, direct (no pgbouncer)                                  | `playerz_production` through `playerz-pgbouncer` |
| Redis     | `playerz-redis`, its own db index                                                         | `playerz-redis`, db 0                            |
| Env file  | `/opt/playerz/.env.staging` (`DEPLOY_ENV=staging`)                                        | `/opt/playerz/.env`                              |
| Host      | `staging.playerz.bg` since 2026-10-07 (the old `staging.35-187-80-26.sslip.io` redirects) | `playerz.bg` (app.playerz.bg and www redirect)   |

`DEPLOY_ENV=staging` makes robots.txt disallow everything and the sitemap empty, so the copy is never indexed.

Staging sends no email: `DEPLOY_ENV=staging` forces the notification outbox's log-only adapter even if a provider key is set (#367), unless `EMAIL_ALLOW_ON_STAGING=1` is set on purpose. Sign-in needs the staging callback URLs (`https://staging.playerz.bg/api/auth/callback/google` and `…/facebook`) registered with each provider — see [Sign-in](#sign-in-361). Both staging blocks are in `deploy/Caddyfile.playerz`.

```bash
# Before anything: the disk is shared with agrent and both databases. Stop if it is tight.
[ "$(df --output=avail -BG / | tail -1 | tr -dc 0-9)" -ge 10 ] || { echo "under 10 GB free: clean up first (below)"; exit 1; }

# Staging, after a merge: build main once, tag it, migrate staging, recreate.
cd /opt/playerz/repo && sudo git fetch -q --all && sudo git reset -q --hard origin/main
sudo nice -n 10 docker build -q --build-arg SKIP_ENV_VALIDATION=1 -t playerz:staging .
sudo docker build -q --target builder -t playerz-migrator:staging .
sudo docker run --rm --network playerz_internal --env-file /opt/playerz/.env.staging -w /app \
  playerz-migrator:staging npx prisma migrate deploy
cd /opt/playerz && sudo docker compose -f docker-compose.staging.yml up -d --force-recreate

# Weekly release: promote what staging has been running, unchanged.
sudo docker tag playerz:local playerz:rollback-$(date +%s)
sudo docker tag playerz:staging playerz:local
sudo docker tag playerz-migrator:staging playerz-migrator:local
sudo docker run --rm --network playerz_internal --env-file /opt/playerz/.env -w /app \
  playerz-migrator:local npx prisma migrate deploy
cd /opt/playerz && sudo docker compose -f docker-compose.prod.yml up -d --force-recreate playerz-app

# After every deploy: keep the two newest rollback images, drop dangling images, cap the build cache.
for t in $(sudo docker images playerz --format '{{.Tag}}' | grep '^rollback-' | sort -t- -k2 -n | head -n -2); do
  sudo docker rmi "playerz:$t"
done
sudo docker image prune -f
sudo docker builder prune -f --keep-storage 6GB
df -h /
```

**Disk hygiene is not optional.** Each image is about 2.5 GB, and a staging build plus a promotion adds two. On 2026-10-07 sixteen kept rollback images and 20 GB of build cache filled the 79 GB disk to 100%. `playerz-db` PANICked on a checkpoint write and restarted itself through WAL recovery, with no data lost, and agrent's Redis failed its background saves until space was freed. Keep two rollback tags at most: the image staging is about to promote is the newest known-good state anyway. `docker image prune -f` only removes dangling images, so agrent's tagged images are never touched by it.

Promoting the staging image, instead of rebuilding, means production runs exactly the bytes that were tested on staging. An urgent fix is the same promotion done mid-week.

## Disk alerts (#440)

`deploy/ops/disk-alert.sh` runs from cron every 15 minutes. It emails
`ALERT_EMAIL` through Resend in two cases:

- `df /` is above 80%;
- `playerz-db`, `playerz-redis` or `playerz-pgbouncer` logged `PANIC`,
  `No space left` or `MISCONF` in the last 20 minutes.

It sends at most one email per condition every 6 hours, and one "OK again"
when the condition clears. It uses the app's own `RESEND_API_KEY` and
`EMAIL_FROM`, read from `/opt/playerz/.env` and never printed. The only thing
it writes on the box is its state directory, `/var/lib/playerz-disk-alert`.

Install from a checkout, on your machine:

```bash
tar -C deploy/ops -cf - disk-alert.sh playerz-disk-alert.cron | gcloud compute ssh agrent \
  --zone europe-west1-b --project hazel-design-419410 --command 'set -e; d=$(mktemp -d); tar -C $d -xf -; cd $d
  sudo install -m 0755 disk-alert.sh /usr/local/sbin/playerz-disk-alert
  sudo install -m 0644 playerz-disk-alert.cron /etc/cron.d/playerz-disk-alert'
```

Then add one line to `/opt/playerz/.env`. Setting `ALERT_FROM` there
overrides the sender, if needed.

```bash
ALERT_EMAIL=ivo@inflect.bg
```

Check it on the box:

```bash
sudo playerz-disk-alert --dry-run                         # sends nothing, writes nothing
sudo DISK_ALERT_THRESHOLD=1 playerz-disk-alert --dry-run  # what an alert says
# One real email, with a throwaway state so the next cron run starts clean:
sudo DISK_ALERT_THRESHOLD=1 DISK_ALERT_STATE_DIR=/tmp/disk-alert-test playerz-disk-alert
sudo rm -rf /tmp/disk-alert-test
journalctl -t playerz-disk-alert --since today            # the cron runs
```

When it fires, the disk-hygiene commands above free what playerz holds:
rollback images, `docker image prune -f`, and
`docker builder prune -f --keep-storage 6GB`. `sudo docker system df` shows
where the rest is. agrent's images and volumes are not ours to prune.

**Container logs are capped** at 10 MB × 3 files per playerz container
(`x-logging` in `deploy/docker-compose.*.yml` and `ops/sweep.compose.yml`).
Docker applies the option when it creates a container:

- `playerz-app`, staging and the sweeps get it at their next
  `up -d --force-recreate`;
- `playerz-db`, `playerz-redis` and `playerz-pgbouncer` get it at their next
  recreate, a few seconds' restart. Do that at a quiet hour:
  `sudo docker compose -f docker-compose.prod.yml up -d --force-recreate db redis pgbouncer`.

agrent's own containers are RodnaPamet/agri-saas#1507. The Docker daemon's
config is shared and stays as it is.

## Sign-in (#361)

Everyone signs in with **Google or Facebook**. There is no password sign-in in
any deployment, and Microsoft Entra is gone (owner decisions Q15/Q21). Each
provider is registered only when both of its variables are set, and its button
appears only then; `/api/ready` reports which are live
(`.features.signIn`). Creating the apps: `docs/oauth-setup.md`.

| Variable                                       | Production and staging                    | What it does                                                                                                                                                                                         |
| ---------------------------------------------- | ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`     | optional — set both                       | Google sign-in. Live in production.                                                                                                                                                                  |
| `FACEBOOK_CLIENT_ID`, `FACEBOOK_CLIENT_SECRET` | optional — set both                       | Facebook sign-in: the Meta app's App ID and App secret.                                                                                                                                              |
| `TEST_PASSWORD_SIGN_IN`                        | **never set**                             | Email + password, for the test suites only, honoured only with `DEPLOY_ENV=test`. A deployment whose environment carries it — any value — **refuses to start** (`src/lib/auth/password-sign-in.ts`). |
| `DEPLOY_ENV`                                   | `staging` on staging; unset on production | Unset means production. `test` is for the E2E, perf and Jest harnesses only, never a deployment.                                                                                                     |
| `MICROSOFT_*`                                  | remove                                    | Read by nothing since #361.                                                                                                                                                                          |

The redirect URIs each provider must have registered, exactly. The host is
`NEXTAUTH_URL`'s — `https://playerz.bg` in production, `https://staging.playerz.bg`
on staging — and the path is fixed by the provider id. Both providers also keep
the `app.playerz.bg` one while that host redirects.

| Provider | Production                                      | Staging                                                 |
| -------- | ----------------------------------------------- | ------------------------------------------------------- |
| Google   | `https://playerz.bg/api/auth/callback/google`   | `https://staging.playerz.bg/api/auth/callback/google`   |
| Facebook | `https://playerz.bg/api/auth/callback/facebook` | `https://staging.playerz.bg/api/auth/callback/facebook` |

On 2026-10-07 both pairs of variables are set in `/opt/playerz/.env` and
`/opt/playerz/.env.staging`; the registrations, and which of them are verified,
are in `docs/oauth-setup.md`. The Meta app registers redirect URIs in strict
mode: a host missing from its list fails at Facebook, after the person has
agreed. Until the app is **Live**, only people with a role on it can sign in
with Facebook; going Live needs a privacy policy URL (#370) and a data-deletion
URL (#445).

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

Serving host: **`playerz.bg`** since 2026-10-07 (`A 35.187.80.26`); `app.playerz.bg` and `www.playerz.bg` 302 to it (see `deploy/Caddyfile.playerz`). Before that it was **`app.playerz.bg`** (`A 35.187.80.26`). As of 2026-09-29 it
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

## Chat push (#481)

Messages reach an open screen through Centrifugo v6, one container per
environment: `playerz-centrifugo` (production) and `playerz-staging-centrifugo`.
Caddy sends `/connection/websocket` on each host to its own broker, and
everything else to the app (deploy/Caddyfile.playerz). The broker asks the app
about every subscription (`/api/v1/realtime/subscribe`), and the app allows
only a person's own `notif:` channel.

Push is ON when the app has both `CENTRIFUGO_TOKEN_SECRET` and
`CENTRIFUGO_API_KEY`. Without them the token route answers `url: null`, the
browser never connects, and chat re-reads on its own interval as before. A
broker that is down degrades the same way: a send never fails on it.

**Secrets.** Four values per environment, generated on the VM, never printed,
written to two files each: the app's env file (its names) and the broker's own
env file (Centrifugo's names, `centrifugo.env` / `centrifugo.staging.env`
next to the compose files, mode 600):

| App (`.env`, `.env.staging`)                                                                    | Broker (`centrifugo*.env`)                                                                |
| ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `CENTRIFUGO_API_URL=http://playerz-centrifugo:8000/api` (staging: `playerz-staging-centrifugo`) | —                                                                                         |
| `CENTRIFUGO_API_KEY`                                                                            | `CENTRIFUGO_HTTP_API_KEY`                                                                 |
| `CENTRIFUGO_TOKEN_SECRET`                                                                       | `CENTRIFUGO_CLIENT_TOKEN_HMAC_SECRET_KEY`                                                 |
| `CENTRIFUGO_PROXY_SECRET`                                                                       | `CENTRIFUGO_CHANNEL_PROXY_SUBSCRIBE_HTTP_STATIC_HEADERS={"X-Centrifugo-Secret":"<same>"}` |

Create the broker's env file BEFORE copying a compose file that names it:
`docker compose up` refuses a missing `env_file`, and the release script
recreates the whole project.

**Checks.**

```sh
# the broker is up and healthy
sudo docker ps --filter name=centrifugo --format '{{.Names}} {{.Status}}'
# Caddy upgrades the socket (101), not the app's 404
curl -s -o /dev/null -w '%{http_code}\n' --http1.1 \
  -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' \
  -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' https://staging.playerz.bg/connection/websocket
# the token route names the socket (signed in): url = wss://<host>/connection/websocket
```

Rotating a secret: change it in both files, then recreate the broker and the
app together; open sockets reconnect and fetch a new token.

## The phone check (#500)

A player or coach confirms a phone number by an SMS code before their first
booking, join request or message. The codes are sent and checked by
**Infobip's 2FA API**, on the owner's Infobip account.

**What exists in the Infobip account** (made once, 2026-10-13):

- one 2FA application, "playerz.bg phone confirmation": a code lives 10
  minutes and gets 5 guesses; at most 6 SMS a day to one number and 2000 a day
  in all;
- two message templates for it, a 6-digit numeric PIN, sender `playerz`:
  Bulgarian «{{pin}} е вашият код за playerz.bg. Не го споделяйте с никого.»
  and English "{{pin}} is your playerz.bg code. Do not share it with anyone."

To change a text or the sender, update the template in Infobip
(`PUT /2fa/2/applications/{appId}/messages/{msgId}`); nothing is redeployed.

**Settings** (the app's env file, all four or none; the fifth is optional):

| Setting                      | What it is                                                    |
| ---------------------------- | ------------------------------------------------------------- |
| `INFOBIP_BASE_URL`           | the account's own API host, `https://<id>.api.infobip.com`    |
| `INFOBIP_API_KEY`            | an API key that may send and verify 2FA PINs                  |
| `INFOBIP_2FA_APPLICATION_ID` | the application above                                         |
| `INFOBIP_2FA_MESSAGE_ID`     | the Bulgarian template                                        |
| `INFOBIP_2FA_MESSAGE_ID_EN`  | the English template; without it everybody gets the Bulgarian |

Put them in with a pipe, never as a command argument, and never print them.

**Turning the rule on.** `REQUIRE_PHONE=1` in the env file, then recreate the
app container. Off (the default), nothing asks for a number and nothing is
blocked. On:

- booking, joining a booking by link, asking to join a game and writing a
  message (as a player) answer `PHONE_REQUIRED` until a number is confirmed;
- a signed-in player or coach with no number is asked once after signing in,
  and may say «Не сега»;
- club staff and the desk are never asked.

`REQUIRE_PHONE=1` without the four Infobip settings does NOT let people
through: the phone step answers 503 `PHONE_VERIFY_UNAVAILABLE` and logs an
error, and the gated actions stay refused. Set the keys first.

**Order for a new environment:** the four settings → recreate → confirm your
own number at `/start/phone` → `REQUIRE_PHONE=1` → recreate.

**What a club sees.** The staff of a club see a player's confirmed number on
that player's upcoming booking at the club, in the diary. Nobody else sees a
number. The privacy policy has to say so (#370).

## Scheduled jobs

Seven routes under `/api/cron` do work nothing else triggers, and each refuses
to run (503) until `CRON_SECRET` is set:

| Route                           | Cadence | Without it                                                                       |
| ------------------------------- | ------- | -------------------------------------------------------------------------------- |
| `release-expired-bookings`      | 60 s    | an abandoned checkout holds its court for ever, and keeps the credit spent       |
| `complete-ended-bookings`       | 60 s    | no booking ever becomes COMPLETED, so nobody can ever leave a review             |
| `warn-expiring-platform-grants` | daily   | a platform grant lapses mid-incident with no warning                             |
| `send-booking-reminders` (#367) | 5 min   | no 3-hour reminders; unanswered open-play requests never lapse (#376)            |
| `drain-email-outbox` (#367)     | 60 s    | confirmation and club-cancellation emails wait in `email_outbox` for ever        |
| `sweep-orphan-media` (#366)     | daily   | photo objects whose rows are gone stay in the bucket (`docs/media-storage.md`)   |
| `report-dead-emails` (#425)     | daily   | an email that died after every retry is seen by nobody (it emails `ALERT_EMAIL`) |

`sweep-orphan-media` also deletes a coach's certificate on a profile left
DRAFT or DECLINED for 30 days with no change (#557, owner decision 28); its
answer's `certificates` says how many went and how many are stored.

`ops/sweep.compose.yml` runs all seven as small `alpine` loops. It is an
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

### Notification email (#367)

The bell needs nothing. EMAIL needs a provider, and production runs without one
until the owner adds it: the outbox drain then uses its log-only adapter, marks
each row SENT by `log`, and sends nothing. To start sending, add ONE of these to
`/opt/playerz/.env` and recreate `playerz-app`:

```bash
# Resend (preferred): an API key with "sending access" for the domain below.
RESEND_API_KEY=re_...
EMAIL_FROM="playerz.bg <noreply@playerz.bg>"

# or SMTP (any provider): 587 uses STARTTLS, 465 implicit TLS.
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_USER=...
SMTP_PASS=...
EMAIL_FROM="playerz.bg <noreply@playerz.bg>"
```

`SITE_URL` must be the public origin (`https://playerz.bg`): every link in an
email is built on it. The sending domain must be verified with the provider
before anything is accepted: in Resend, add the domain `playerz.bg` and create
the DNS records it lists (an SPF `TXT` on the `send` subdomain, the DKIM
`resend._domainkey` `TXT`, and its MX for bounces), then a DMARC record on
`_dmarc.playerz.bg` (`v=DMARC1; p=none; rua=mailto:<owner>` to start). An
unverified domain is refused as `invalid_from_address`; the drain retries it
with backoff (1 min, 5 min, 15 min, 1 h, 3 h) and dead-letters after 6 attempts,
so verify before adding the key.

The two loops are `booking-reminders` and `email-outbox` in
`ops/sweep.compose.yml`; copy the file beside `docker-compose.prod.yml` again
and `up -d` as above. Check a run from inside a container:

```bash
sudo docker exec playerz-email-outbox sh -c \
  'wget -q -O- --post-data="" --header="x-cron-secret: $CRON_SECRET" http://playerz-app:3000/api/cron/drain-email-outbox'
# → {"provider":"log","claimed":0,"sent":0,"retried":0,"dead":0,"skipped":0}
```

`provider` says which adapter the app picked (`resend`, `smtp` or `log`). Rows
that failed for good are `status = 'DEAD'` in `email_outbox`, with `lastError`
(never the address or the body).

#### One-click unsubscribe (#528)

Every email a person can switch off (the five kinds under Профил → Известия)
goes out with a last line, "Спиране на тези имейли с едно натискане: …", and two
headers:

```
List-Unsubscribe: <https://playerz.bg/api/email/unsubscribe/{token}>
List-Unsubscribe-Post: List-Unsubscribe=One-Click
```

Gmail, Apple Mail and the rest turn those into their own "unsubscribe" beside
the sender and POST to that address themselves (RFC 8058). The line in the body
leads to a page that asks first. Either way the token switches off one kind of
email for one account and nothing else, with no sign-in. The operator's enquiry
email carries neither.

Nothing to configure. Two things to know:

- The links are built on `SITE_URL`, like every link in an email.
- The token is signed with a key derived from `DATA_ENCRYPTION_KEY`. Rotating
  that key voids the unsubscribe links in every email already sent; the other
  footer line (Профил → Известия) still works.

Check a link by hand (it changes nothing until the button is pressed):

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://playerz.bg/email/unsubscribe/not-a-real-token   # 200, "Връзката не е валидна"
curl -s -X POST https://playerz.bg/api/email/unsubscribe/not-a-real-token                       # 404 NOT_FOUND
```

## Backups

Two layers, and they answer different questions:

| Layer                     | What                                                      | When                       | Kept    | Restores                                         |
| ------------------------- | --------------------------------------------------------- | -------------------------- | ------- | ------------------------------------------------ |
| Disk snapshot             | `agrent-daily-snapshot` on the VM's whole disk            | 02:00 UTC                  | 14 days | the whole VM, agrent included, as of that moment |
| Logical dump (#218, this) | `pg_dump -Fc` of `playerz_production` only, ~270 KB today | 03:15 Europe/Sofia nightly | 30 days | playerz's database, into any Postgres 16+PostGIS |

The snapshot is crash-consistent — a restored Postgres recovers as if from a
power cut — and getting one table back means standing up a disk beside agrent
and fishing in it. The dump is a clean, transaction-consistent copy of playerz
alone that `pg_restore` reads directly, and it outlives the snapshots by 16
days. Keep both: the snapshot also covers `/opt/playerz/.env`, Caddy and
everything else that is not in the database.

### Where it goes

`gs://playerz-db-backups-hazel/playerz/YYYY/MM/DD/playerz-<UTC timestamp>.dump`
— project `hazel-design-419410`, `europe-west1`, uniform bucket-level access,
public access prevention enforced, lifecycle **delete at 30 days** (plus GCS's
default 7-day soft delete behind that).

### Credentials

The VM's default service account has the `devstorage.read_only` **access
scope**, and a scope caps the token whatever IAM says, so it cannot write to
any bucket. Widening the scope needs the VM stopped, which takes agrent down.

So uploads use a dedicated account,
`playerz-db-backup@hazel-design-419410.iam.gserviceaccount.com`, with
`roles/storage.objectCreator` and `roles/storage.objectViewer` on **this
bucket only** and no project roles. Its key is
`/etc/playerz-db-backup/sa-key.json` (root, `0600`, directory `0700`), and the
scripts hand it to gcloud per-process via
`CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE`, so root's own gcloud identity on the
box is untouched. objectCreator cannot delete or overwrite: a compromised box
can add objects but cannot erase the history.

To rotate: `gcloud iam service-accounts keys create` a new key, stream it into
that path over `gcloud compute ssh ... 'sudo sh -c "umask 077; cat > ..."'`
(never via a file on someone's laptop that outlives the command), run the job
once, then delete the old key.

### What runs, and how it is installed

`ops/backup/` in this repo — a systemd timer on the host, not a compose
overlay: it needs a wall-clock time in a named zone, `docker exec` into
`playerz-db` (a container would need the Docker socket, which is root over
agrent too), and gcloud, which the host already has. The script's header says
more.

```bash
# from a checkout, on your machine
tar -C ops/backup -cf - . | gcloud compute ssh agrent --zone europe-west1-b \
  --project hazel-design-419410 --command 'set -e; d=$(mktemp -d); tar -C $d -xf -; cd $d
  sudo install -m 0755 playerz-db-backup.sh     /usr/local/sbin/playerz-db-backup
  sudo install -m 0755 playerz-restore-drill.sh /usr/local/sbin/playerz-restore-drill
  sudo install -m 0644 playerz-db-backup.service playerz-db-backup.timer /etc/systemd/system/
  sudo systemctl daemon-reload && sudo systemctl enable --now playerz-db-backup.timer'
```

Each run dumps inside `playerz-db`, checks the dump with `pg_restore --list`,
uploads it, then **downloads it back**, `cmp`s it and `pg_restore --list`s the
downloaded copy — so a green run means the object in the bucket is readable,
not merely that something was sent. The local copy is deleted on exit.

Its temp files are capped (#440):

- a run refuses to start with under 2 GB free where it writes
  (`PLAYERZ_BACKUP_MIN_FREE_MB`);
- it cannot write a file over 2 GB (`PLAYERZ_BACKUP_MAX_DUMP_MB`, via
  `ulimit -f`);
- it deletes the run directories a killed run left, once they are an hour old;
- gcloud keeps no log files.

After a change to the script, install it again with the command above.

**Installed 2026-10-01.** First object:
`playerz/2026/10/01/playerz-20261001T112619Z.dump`, 276,641 bytes, 718 TOC
entries. The database is ~113 MB on disk but nearly all of that is PostGIS's
own tables and indexes; pg_dump emits only their configuration rows.

### Did last night's run happen?

```bash
systemctl list-timers playerz-db-backup.timer         # LAST should be ~03:15 Sofia today
systemctl show playerz-db-backup -p Result            # Result=success
journalctl -u playerz-db-backup --since yesterday -o cat | grep playerz-db-backup:
# → playerz-db-backup: OK gs://.../playerz-<ts>.dump size=...B toc_entries=718 (local 718) db=playerz_production
gcloud storage ls -l "gs://playerz-db-backups-hazel/playerz/$(date -u +%Y/%m/%d)/"
```

A failure logs `playerz-db-backup: FAILED during: <step>` and leaves the unit
`failed`, so it also shows in `systemctl --failed`. Run one now with
`sudo systemctl start playerz-db-backup` — it is oneshot, so the command
returns when the run is done.

### Restoring

**Drill first, always.** `playerz-restore-drill` restores a dump (the newest,
or the `gs://` path you give it) into a scratch database
`playerz_restore_drill` inside `playerz-db`, compares exact `count(*)` for
every table against production, and drops the scratch database on exit. It
refuses if the scratch name is ever production's.

```bash
sudo systemctl start playerz-db-backup     # a fresh dump, so the counts are comparable
sudo /usr/local/sbin/playerz-restore-drill
# → playerz-restore-drill: OK 100 tables, 17461 rows, every count matches production
```

Run on 2026-10-01 against the first dump: **100 tables, 17,461 rows, every
count matched** (`_prisma_migrations` 34, `app_user` 2, `venue` 1,
`venue_org` 1, `user_session` 3, `spatial_ref_sys` 8,500, the rest PostGIS
tiger lookups or empty). The counts are compared against production _now_, so
a table that took writes since the dump will show as a MISMATCH by exactly
those writes — read the diff before concluding anything.

**For real** — production lost or corrupted — restore into a new database,
check it, then swap the app over. Never `pg_restore --clean` over
`playerz_production` in place: if the dump turns out to be the wrong one,
there is then nothing left to go back to.

```bash
sudo docker compose -f /opt/playerz/docker-compose.prod.yml stop playerz-app  # and the sweeps
OBJ=gs://playerz-db-backups-hazel/playerz/YYYY/MM/DD/playerz-....dump
sudo env CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE=/etc/playerz-db-backup/sa-key.json \
  CLOUDSDK_CONFIG=/var/lib/playerz-db-backup/gcloud gcloud storage cp "$OBJ" /root/restore.dump
sudo docker exec playerz-db psql -U playerz -d postgres -c \
  'CREATE DATABASE playerz_restored TEMPLATE template0;'
sudo docker exec -i playerz-db pg_restore -U playerz -d playerz_restored \
  --exit-on-error --single-transaction < /root/restore.dump
# check it, then swap names (nothing may be connected to either):
sudo docker exec playerz-db psql -U playerz -d postgres \
  -c 'ALTER DATABASE playerz_production RENAME TO playerz_broken_YYYYMMDD;' \
  -c 'ALTER DATABASE playerz_restored  RENAME TO playerz_production;'
# the one database-level setting production has, which pg_dump (without
# --create) does not carry — the PostGIS image's initdb put it there:
sudo docker exec playerz-db psql -U playerz -d postgres -c \
  "ALTER DATABASE playerz_production SET search_path = \"\$user\", public, topology, tiger;"
sudo docker compose -f /opt/playerz/docker-compose.prod.yml -f /opt/playerz/sweep.compose.yml up -d
sudo shred -u /root/restore.dump
```

Roles are cluster-wide, so `playerz_app` and its password survive this
untouched; the dump only carries its GRANTs. If the whole `playerz-db` volume
is gone, bring up an empty `playerz-db` first, then set `playerz_app`'s
password as in "The database roles" after the restore.

## Verifying

```bash
curl -s https://playerz.bg/api/ready
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

- **The Facebook app is in Development mode.** Only people with a role on it
  can sign in with Facebook until it goes Live, which needs a privacy policy URL
  (#370) and a data-deletion URL (#445). See [Sign-in](#sign-in-361).

- **Almost no data.** As of 2026-09-29: one club (`demo-sofia`), two accounts,
  zero bookings.

## Shared with agrent

- **`ANTHROPIC_API_KEY`** in `/opt/playerz/.env` was copied server-side from
  `/opt/agrent/.env` on 2026-09-29 (review moderation, #257). The two products
  share one key: rotating it means updating **both** files and recreating both
  apps.
- The VM, Caddy (reload, never restart) and the `agrent_internal` network — see
  above.
