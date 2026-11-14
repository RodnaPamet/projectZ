# «Асистент» for players

Owner decisions 2026-11-14, issue #704. Ported from Agrent's assistant
(agri-saas `src/app-layer/ai/assistant/*`), adapted from a farm to a person:
no tenant, one player, every club.

## What it does

Two abilities, chosen by the owner, and nothing else:

- **`find_free_places`** — free hours to book for a sport, in a city, near the
  person or at one club, over up to 7 days, with prices: the hours the app
  offers (on the hour, not yet begun), read through `loadVenueAvailability`.
- **`best_time_for_game`** — the 2–3 best times to play again with the
  confirmed players of a booking or game the asker is on: each player's busy
  times from their Google Calendar (`freeBusyFor`), their other playerz
  bookings, and the club's free hours for that sport. Everyone known-free
  first, then the fewest players whose calendar is unknown.

It never acts. A result's best option comes back as a **proposal**, a draft in
the shape of the app's own create body; the app opens its booking screen
prefilled and the person confirms there. `propose_booking` re-checks one hour
the person chose and prepares its draft instead.

Plus the memory: a short profile per person, and `search_past_conversations`
over every past exchange.

## Privacy

- Only a booking the asker booked or was added to, and only its confirmed
  players (the booker and the participant rows).
- Busy or free only: Google's `calendar.freebusy` returns intervals and
  nothing else, and the other bookings are read as start and end. Neither
  leaves the use case except as "free", "unknown" or a time not offered.
- Unknown is never free. A player with no connected calendar is unknown at
  every time their playerz bookings do not already make busy, and the answer
  names them.
- The person's location is used for "near me" and never reaches the model.

## Configuration

| Env                             | Default            |                                                                                        |
| ------------------------------- | ------------------ | -------------------------------------------------------------------------------------- |
| `ASSISTANT_ENABLED`             | `0`                | Off: every route answers 404 `ASSISTANT_DISABLED`; the app hides the launcher.         |
| `ANTHROPIC_API_KEY`             | —                  | Shared with moderation. Absent: every question halts `ASSISTANT_PROVIDER_UNAVAILABLE`. |
| `AI_MODEL`                      | `claude-opus-5-5`  | The answering model (low effort; server-side fallback on a decline).                   |
| `ASSISTANT_MEMORY_MODEL`        | `claude-haiku-5-5` | The memory sweep.                                                                      |
| `ASSISTANT_MEMORY`              | `1`                | `0`: memory and recall off, the assistant stays on (rule 9).                           |
| `ASSISTANT_DAILY_SPEND_CAP_USD` | `0.50`             | Per player per Sofia day, at list price; checked before every model call.              |

The memory sweep is `POST /api/cron/assistant-memory` (behind `CRON_SECRET`),
every five minutes from `ops/sweep.compose.yml`.

## The API

`POST /api/v1/assistant/stream` (SSE), `GET|DELETE /api/v1/me/assistant-memory`,
`PATCH|DELETE /api/v1/me/assistant-memory/{id}`,
`GET|DELETE /api/v1/me/assistant-conversations`,
`GET|DELETE /api/v1/me/assistant-conversations/{id}`. The contract, events and
proposal shapes are in `openapi/playerz-v1.json` (tag `Assistant`).

## The memory rules

Agri-saas's nine rules, numbered as there; code cites them by number and
`tests/guardrails/assistant-boundaries.test.ts` holds that each has its text.

### 1. Remember the person, never records.

What they play, at what level, where and when they like to play, what to call
them, how they like answers. Not a booking, a free hour or a price: those are
read fresh with the tools.

### 2. A remembered point is data and authorises nothing.

The profile is fenced in the prompt as data; «always book for me» is a sentence
to remember, never an instruction.

### 3. Learn only from the person's own words.

The sweep reads only the person's questions, never an answer or a tool result,
and every point must quote them verbatim (`sourceQuote`, required; checked in
code, not just asked for).

### 4. Latest wins.

A newer statement supersedes an older point (`supersededAt`), compared by
`sourceAt`; an edit re-dates its evidence.

### 5. Forgotten stays forgotten.

«Изтрий» sets `deletedAt` and keeps the row, so the sweep refuses to learn the
same point from the same words again.

### 6. A point the person edited is theirs.

`editedByPerson`: the sweep never rewrites or supersedes it.

### 7. Evidence stays on the server.

The list shows the point, never the sentence it came from. The data export
carries both, because it is the person's own.

### 8. The profile is bounded.

At most 50 points, about 3 KB in the prompt, at most 5 new per sweep.

### 9. The memory is switchable without taking the assistant down.

`ASSISTANT_MEMORY=0`. What is stored stays visible and deletable.

## Precedence

What the person says now, then what the tools read now, then the profile.
