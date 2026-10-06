# Venue photos: storage and serving (#366)

Clubs upload a cover and a gallery (up to 12) per venue under **Админ → Снимки и
информация** (`/t/{slug}/admin/photos`, OWNER and MANAGER). Players keep their Google or
Facebook picture; they upload nothing.

This page is for whoever sets the storage up on the VM. Nothing here has been created
yet: the commands below are to be run once, by a person with owner rights on project
`hazel-design-419410`.

## How it works

| Step     | What happens                                                                                                                                                                                                                                                                                                                                                                                                                  |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Upload   | `POST /api/t/{slug}/admin/venues/{venueId}/photos`, multipart, from the admin screen. Authorised (`admin.venue_manage`, from the database role) before the body is read; the body is read with an 8 MB cap (Caddy and the edge proxy stop at 10 MB). 30 uploads per 10 minutes per person.                                                                                                                                    |
| Check    | The format comes from the file's magic bytes: JPEG, PNG, WebP, HEIF. SVG, HTML, GIF and everything else are refused before any decoder runs. The header is read first and anything over 50 megapixels is refused (decompression bombs); sharp's `limitInputPixels` enforces the same. One upload is decoded at a time.                                                                                                        |
| Process  | sharp re-encodes from pixels, so nothing of the original survives: EXIF, GPS, XMP and ICC are dropped, the EXIF orientation is applied first. WebP renditions at 640, 1280 and 1920 px wide (never wider than the upload), plus a ~16 px blur placeholder kept in the database.                                                                                                                                               |
| Store    | `venues/{venueId}/{uuid}-{width}.webp`, `Content-Type: image/webp`, `Cache-Control: public, max-age=31536000, immutable`, written create-only (`ifGenerationMatch: 0`). A replaced photo is a new name, never an overwrite, so the year-long cache is safe.                                                                                                                                                                   |
| Record   | One `venue_photo` row per upload (P47): `kind` COVER or GALLERY, `objectKey` (the stem), `widths`, the largest rendition's size, the blur, the alt text (required). One cover per venue (a partial unique index); a trigger refuses a row whose venue belongs to another club.                                                                                                                                                |
| Serve    | Pages render a plain `<img srcset sizes>` straight from the bucket, with the blur behind it. No `next/image`: it would resize again on the VM's CPU. URLs are built at read time from `MEDIA_PUBLIC_BASE_URL`, so putting a CDN in front later is an env change, not a migration. `/api/v1/venues` (list and detail) carry `cover` and `photos` with every width and the alt, for the iOS app.                                |
| Delete   | Removing a photo deletes its row, then its objects. A replaced cover's objects go after the new one commits.                                                                                                                                                                                                                                                                                                                  |
| Clean up | `POST /api/cron/sweep-orphan-media`, daily (`ops/sweep.compose.yml`, `media-sweep`), deletes every object under `venues/` that no row names and that is over a day old. That covers a delete that failed while storage was down, an upload that died half way, and a venue or club removal: their rows cascade, and the next sweep deletes the objects. `purgeVenueMedia()` does it at once for a removal path that wants to. |

Code: `src/lib/media/` (adapters, keys, image processing, URL building),
`src/app-layer/usecases/venue-photos.ts`, the route above, `src/app/media/[...key]/route.ts`
(the local adapter's reader) and the admin screen under `src/app/(app)/t/[slug]/admin/photos/`.

## The two adapters

`MEDIA_STORAGE` picks one; unset turns uploads off, and the admin screen says
"Качването на снимки не е настроено" instead of failing. Photos already stored still show.

| `MEDIA_STORAGE` | Where                                                                                                     | Used by                                |
| --------------- | --------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| `gcs`           | the bucket in `GCS_BUCKET`                                                                                | production, staging                    |
| `local`         | files under `MEDIA_LOCAL_DIR` (default `.media`, git-ignored), served by `/media/...` from the app itself | dev, integration tests, CI, E2E builds |

Local files are served by a route rather than from `public/`, because `next start` only
serves the `public/` files that existed when it booted. The route answers 404 unless
`MEDIA_STORAGE=local`, and only for names that match the rendition pattern exactly.

## Why not the VM's own service account

The plan was Application Default Credentials from the VM's service account, with no key.
That does not work on this VM, measured on 2026-10-06:

```console
$ gcloud compute instances describe agrent --zone europe-west1-b \
    --project hazel-design-419410 --format='json(serviceAccounts)'
  "email": "880736019978-compute@developer.gserviceaccount.com",
  "scopes": [ "https://www.googleapis.com/auth/devstorage.read_only", ... ]
```

1. The default compute account has the **`devstorage.read_only` access scope**. A scope
   caps the token whatever IAM grants, so `roles/storage.objectAdmin` on the bucket would
   still give a token that cannot write. (`docs/deploy-gcp.md` says the same about the
   database backups.)
2. Widening the scope needs the VM **stopped**, which takes agrent down with it.
3. That account is a **project Editor**. With a read-write scope, any code running in the
   playerz container could write and delete every bucket in the project, the database
   backups included, which is what the backup design exists to prevent.

So uploads use a **dedicated service account with `roles/storage.objectAdmin` on the media
bucket only**, the pattern the backups already use (`playerz-db-backup@`). Its key reaches
the app as `GCS_CREDENTIALS_BASE64` in the `.env` the app already reads (`env_file`), so
neither compose file changes and no key file is mounted. The client library uses ADC when
the variable is unset, so if the VM's scopes are ever widened (at the next planned
downtime), dropping the variable and granting the VM's account instead is the whole
change.

Staging gets **its own bucket and its own account**, so nothing staging runs can touch a
production photo.

## The commands

Run from a machine with owner rights on the project. Each block is idempotent enough to
re-run, except that `keys create` makes a new key each time.

Checked on 2026-10-06: no organisation policy on the project enforces public access
prevention (`storage.publicAccessPrevention`) or blocks key creation
(`iam.disableServiceAccountKeyCreation`), so the public binding and the keys below are
allowed.

### 1. Buckets

```bash
PROJECT=hazel-design-419410
for B in playerz-media-hazel playerz-media-staging-hazel; do
  gcloud storage buckets create "gs://$B" \
    --project="$PROJECT" --location=europe-west1 \
    --default-storage-class=STANDARD \
    --uniform-bucket-level-access \
    --no-public-access-prevention \
    --soft-delete-duration=7d
done
```

- **Uniform bucket-level access**: IAM only, no per-object ACLs.
- **Public read, no listing.** `allUsers` gets `roles/storage.legacyObjectReader`, which is
  `storage.objects.get` and nothing else. Not `roles/storage.objectViewer`: that also
  grants `storage.objects.list`, and the whole bucket could be enumerated.

  ```bash
  for B in playerz-media-hazel playerz-media-staging-hazel; do
    gcloud storage buckets add-iam-policy-binding "gs://$B" \
      --member=allUsers --role=roles/storage.legacyObjectReader
  done
  ```

- **No CORS.** The browser never talks to the bucket except through `<img>`, which needs
  none; uploads go through the app.
- **Lifecycle**: no age-based deletion. A photo lives until the club removes it, and the
  app and the daily sweep delete objects then. The one rule clears multipart debris, should
  anything ever write that way:

  ```bash
  cat > /tmp/playerz-media-lifecycle.json <<'JSON'
  {"rule": [{"action": {"type": "AbortIncompleteMultipartUpload"}, "condition": {"age": 1}}]}
  JSON
  for B in playerz-media-hazel playerz-media-staging-hazel; do
    gcloud storage buckets update "gs://$B" --lifecycle-file=/tmp/playerz-media-lifecycle.json
  done
  ```

  Deleted objects stay recoverable for 7 days (soft delete, set above).

- **No CDN for the pilot.** Public objects with `Cache-Control: public` are cached at
  Google's edge already. To put Cloud CDN and a name like `media.playerz.bg` in front later
  (an external HTTPS load balancer with a backend bucket), set `MEDIA_PUBLIC_BASE_URL` to
  that origin and recreate the app; stored rows need nothing.

### 2. Service accounts, each on its own bucket only

```bash
PROJECT=hazel-design-419410
gcloud iam service-accounts create playerz-media --project="$PROJECT" \
  --display-name="playerz venue photos (production, #366)"
gcloud iam service-accounts create playerz-media-staging --project="$PROJECT" \
  --display-name="playerz venue photos (staging, #366)"

gcloud storage buckets add-iam-policy-binding gs://playerz-media-hazel \
  --member="serviceAccount:playerz-media@$PROJECT.iam.gserviceaccount.com" \
  --role=roles/storage.objectAdmin
gcloud storage buckets add-iam-policy-binding gs://playerz-media-staging-hazel \
  --member="serviceAccount:playerz-media-staging@$PROJECT.iam.gserviceaccount.com" \
  --role=roles/storage.objectAdmin
```

No project-level role for either. `objectAdmin` (not `objectCreator`) because the app
deletes objects when a club removes a photo, and the sweep lists the bucket.

### 3. Keys into the env files, straight from gcloud to the box

The key goes from `keys create` through a pipe to the VM and is appended to the env file
there, never written to the laptop's disk and never on a command line.

```bash
PROJECT=hazel-design-419410
put_key() {  # $1 = account, $2 = env file on the box
  gcloud iam service-accounts keys create /dev/stdout \
    --iam-account="$1@$PROJECT.iam.gserviceaccount.com" |
    base64 | tr -d '\n' |
    gcloud compute ssh agrent --zone europe-west1-b --project "$PROJECT" --command \
      "sudo sh -c 'umask 077; { printf \"GCS_CREDENTIALS_BASE64=\"; cat; echo; } >> $2'"
}
put_key playerz-media         /opt/playerz/.env
put_key playerz-media-staging /opt/playerz/.env.staging
```

### 4. The other env lines

In `/opt/playerz/.env` (production):

```
MEDIA_STORAGE=gcs
GCS_BUCKET=playerz-media-hazel
MEDIA_PUBLIC_BASE_URL=https://storage.googleapis.com/playerz-media-hazel
# GCS_CREDENTIALS_BASE64=… appended by step 3
```

In `/opt/playerz/.env.staging`:

```
MEDIA_STORAGE=gcs
GCS_BUCKET=playerz-media-staging-hazel
MEDIA_PUBLIC_BASE_URL=https://storage.googleapis.com/playerz-media-staging-hazel
# GCS_CREDENTIALS_BASE64=… appended by step 3
```

Then recreate the apps (and the sweep overlay, which gained `media-sweep`):

```bash
cd /opt/playerz
sudo docker compose -f docker-compose.prod.yml -f sweep.compose.yml up -d --force-recreate playerz-app media-sweep
sudo docker compose -f docker-compose.staging.yml up -d --force-recreate
```

`sweep.compose.yml` is copied from `ops/` in this repo, as before.

### 5. Check it

```bash
B=playerz-media-hazel
# Listing is refused to the public (expect 401 or 403), through both APIs:
curl -s -o /dev/null -w '%{http_code}\n' "https://storage.googleapis.com/storage/v1/b/$B/o"
curl -s -o /dev/null -w '%{http_code}\n' "https://storage.googleapis.com/$B"
# Upload a cover in the admin, then read one of its URLs (from the venue page's HTML):
curl -sI "https://storage.googleapis.com/$B/venues/<venueId>/<uuid>-1280.webp" |
  grep -iE '^(HTTP|content-type|cache-control)'
# → 200, image/webp, public, max-age=31536000, immutable
# The sweep answers (inside its container, with its own secret):
sudo docker exec playerz-media-sweep sh -c \
  'wget -q -O- --post-data="" --header="x-cron-secret: $CRON_SECRET" http://playerz-app:3000/api/cron/sweep-orphan-media'
# → {"scanned":N,"deleted":0,"truncated":false}
```

To rotate a key: `keys create` a new one with step 3 (remove the old
`GCS_CREDENTIALS_BASE64` line first), recreate the app, check an upload, then
`gcloud iam service-accounts keys delete` the old key.
