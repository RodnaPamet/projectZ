# Deploying playerz.bg to Fly.io

`fly.toml` is committed. What follows is the part that needs an account.

## Why `fra`

Frankfurt is the closest Fly region to Sofia. Bucharest would be nearer at
~300km, but **`otp` is not a Fly region** — the European list is Frankfurt,
Amsterdam, London, Paris and Stockholm. Check with `flyctl platform regions`
before assuming one exists; this config originally said `otp` and would not
have deployed.

**Co-locate Postgres with the app.** The app-to-database round trip happens
several times per request; the user-to-app one happens once.

## Provisioning, once

```bash
fly auth login
fly apps create playerz-bg --org <your-org>

# Postgres, same region as the app.
fly postgres create --name playerz-db --region fra --vm-size shared-cpu-1x
fly postgres attach playerz-db --app playerz-bg     # sets DATABASE_URL

# Redis. The rate limiter falls back to an in-memory Map without it, which is
# per-machine — so with more than one machine the limits are per-machine too,
# and `login:<ip>` stops meaning what it says.
fly redis create --name playerz-redis --region fra
fly secrets set REDIS_URL='<the redis:// URL fly prints>' --app playerz-bg
```

## Secrets

Three of these refuse to boot in production, by design — the app validates them
at startup rather than failing later at the moment a user needs them:

```bash
fly secrets set --app playerz-bg \
  NEXTAUTH_SECRET="$(openssl rand -base64 48)" \
  DATA_ENCRYPTION_KEY="$(openssl rand -base64 48)" \
  NEXTAUTH_URL="https://playerz-bg.fly.dev"
```

`NEXTAUTH_SECRET` was undeclared until this change and read in six places. A
deploy without it **boots cleanly and rejects every authenticated request** —
the app starts, serves public pages, and nobody can sign in. It is now a
startup failure instead.

Optional, and each disables a feature rather than breaking the app —
`/api/ready` reports which are live:

```bash
fly secrets set --app playerz-bg \
  GOOGLE_CLIENT_ID=… GOOGLE_CLIENT_SECRET=… \
  MICROSOFT_CLIENT_ID=… MICROSOFT_CLIENT_SECRET=… \
  APNS_KEY_ID=… APNS_TEAM_ID=… APNS_PRIVATE_KEY="$(awk 'BEGIN{ORS="\\n"}{print}' AuthKey_PROD.p8)" \
  APNS_KEY_ID_SANDBOX=… APNS_PRIVATE_KEY_SANDBOX="$(awk 'BEGIN{ORS="\\n"}{print}' AuthKey_SANDBOX.p8)"
```

Both APNs pairs, because each key is scoped to one environment — a debug build
registers against sandbox, TestFlight against production, and one key reaches
half the devices. See #212.

## Deploying

```bash
fly deploy --app playerz-bg
```

Deploys are manual for now. A GitHub Actions workflow that deploys `main`
after CI passes is in a separate pull request, because changing
`.github/workflows/` needs review that the rest of this does not.

`release_command` runs `prisma migrate deploy` in a one-off machine against the
new image and **aborts the deploy if it fails**, so a bad migration never
reaches a serving instance. Migrations deliberately do not run at container
start: that races every replica against every other one.

## After the first deploy

Check what the app thinks is configured, rather than assuming:

```bash
curl -s https://playerz-bg.fly.dev/api/ready | jq .features
```

It reports push per APNs environment and sign-in per provider. `configured`
means the credentials are present — not that Apple or Google accept them.
