# Google Calendar sync

A player turns on «Синхронизирай с Google Календар» in their profile. playerz
then keeps a calendar called **playerz** in their own Google account in step
with their schedule: court bookings, open games they joined, lessons (as a
player, and as the coach who teaches them) and tournament matches that have a
court and a time. A cancelled game disappears from the calendar. Owner
decision, 2026-11-14.

It is off until `GOOGLE_CALENDAR_SYNC=1` is set. While it is off, the switch is
hidden and every calendar route answers 404 `GOOGLE_CALENDAR_SYNC_DISABLED`.

## What the owner does in Google Cloud

Everything happens in the project `playerzbg`, the one the Google sign-in
already uses. The steps use the same web OAuth client as sign-in. Nothing new
is created, and no secret changes.

### 1. Add the redirect address to the web client

<https://console.cloud.google.com/auth/clients> → open the **web** client
(`32614007699-v720…`) → **Authorised redirect URIs** → add:

```
https://playerz.bg/api/integrations/google-calendar/callback
https://staging.playerz.bg/api/integrations/google-calendar/callback
```

Save. It must match exactly: `https`, no slash at the end.

### 2. Add the two calendar permissions to the consent screen

<https://console.cloud.google.com/auth/scopes> → **Add or remove scopes** →
paste these two into "Manually add scopes" → **Add to table** → **Update** →
**Save**:

```
https://www.googleapis.com/auth/calendar.app.created
https://www.googleapis.com/auth/calendar.freebusy
```

Leave `openid`, `email` and `profile` as they are. Ask for nothing else:
not the full `calendar` permission, and no Drive or contacts.

What the two permissions allow:

- `calendar.app.created`: make the playerz calendar, and add, change and
  delete events **only in calendars playerz made**. playerz cannot read or
  touch the person's other calendars. We do not use `calendar.events`, which
  was the first idea: it reaches every event in every calendar, and it does
  not allow making a calendar at all.
- `calendar.freebusy`: see when the person is busy or free, and nothing else.
  No titles, no places, no names. The assistant will use it to suggest a time
  that suits every player on a game.

Both are "sensitive" permissions. That is why steps 3 and 4 exist.

### 3. Until Google approves: add test users

While the app is waiting for verification, Google lets only listed accounts
through the calendar consent. Everyone else gets "Google hasn't verified this
app".

<https://console.cloud.google.com/auth/audience> → **Test users** → **Add
users** → add your own Gmail address and those of the people trying it (up to
100).

A test user's calendar connection expires after **7 days**. After that the app
says «Свържете отново», and switching it on again fixes it. Verification
removes that limit.

Google sign-in is not affected. It asks only for `openid email profile`, which
need no verification.

### 4. Submit for verification

<https://console.cloud.google.com/auth/verification> → **Prepare for
verification**. Google asks for:

1. **App home page**: `https://playerz.bg`.
2. **Privacy policy link**: `https://playerz.bg/privacy`. The policy must
   say, in plain words, that with the person's permission playerz writes
   their games into a calendar of its own in their Google account, reads only
   busy/free times for suggesting game times, does not read event details,
   and that they can switch it off in the profile at any time (which also
   removes playerz's access in Google).
3. **Authorised domain**: `playerz.bg` (already there for sign-in).
4. **Why each permission**: copy the two lines from step 2.
5. **A demo video** (YouTube, can be unlisted), in English, about two
   minutes, showing:
   - signing in to playerz.bg and opening **Профил**;
   - turning on «Синхронизирай с Google Календар»;
   - Google's consent screen, with the address bar showing the OAuth client
     id, and both permissions visible;
   - coming back to playerz: «Свързан с …» and the last sync time;
   - Google Calendar with the **playerz** calendar and a booking in it;
   - cancelling that booking in playerz, «Синхронизирай сега», and the event
     gone from Google Calendar;
   - turning the switch off.
6. Submit. Google answers by email, usually within a few weeks, sometimes
   with questions. Answer them from the same address.

### 5. Turn it on

On the server, in the app's `.env` (staging first):

```
GOOGLE_CALENDAR_SYNC=1
```

Recreate the app container, and bring up the `calendar-sync` loop from
`ops/sweep.compose.yml`, which calls `POST /api/cron/sync-calendars` every
five minutes.

## How it works

| Piece                                            | What it does                                                                               |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| `POST /api/v1/me/calendar/google/connect`        | `{client: ios\|web}` → Google's consent URL, with a single-use `state` held by the server  |
| `GET /api/integrations/google-calendar/callback` | stores the grant (encrypted), makes the playerz calendar, first sync, redirects back       |
| `GET /api/v1/me/calendar`                        | connected, as whom, last sync, last result, error                                          |
| `POST /api/v1/me/calendar/google/sync`           | «Синхронизирай сега»                                                                       |
| `DELETE /api/v1/me/calendar/google`              | the switch off: revokes at Google, forgets the grant; the playerz calendar stays in Google |
| `POST /api/cron/sync-calendars`                  | every 5 minutes: connections marked dirty, then any not synced for 6 hours                 |
| `src/app-layer/usecases/google-calendar*.ts`     | the connect flow, the sync, `freeBusyFor`                                                  |
| `src/lib/google-calendar/`                       | Google's OAuth and Calendar API, and the diff (`plan.ts`)                                  |

The phone comes back to `bg.playerz.app://integrations/google-calendar` with
`?result=connected` or `?error=<code>`. The codes are a closed set:
`access_denied`, `insufficient_scope`, `state_expired`, `state_invalid`,
`token_exchange_failed`, `feature_disabled`, `internal_error`.

The rules the sync follows, ported from Agrent's farm calendar:

- It reads 30 days back to a year ahead. It deletes an event only when the
  event's own start falls inside that window, and only when nothing was
  capped. Otherwise it reports `partial: true` and deletes nothing.
- Each event carries playerz's id and a fingerprint of what playerz wrote. An
  event the person changed by hand (title or time) is never updated or
  deleted again.
- When the database records a change to a booking, a place on one, a lesson
  or a request to join a game, it marks the people involved as due, in the
  same transaction (P88). The loop syncs them within five minutes.
- When Google answers `invalid_grant` or 401, the connection is marked
  `REVOKED` and the app shows «Свържете отново».
- Deleting an account deletes the connection and revokes the grant at Google.
  The data export says that a connection exists and which Google account it
  is. It never includes the token.

Revoking (the switch off, or account deletion) ends everything this Google
client holds for the person, the sign-in permission included. Their next
Google sign-in shows the consent screen once more, and it still signs them in.
