# P10 — open play, Glicko-2 & chat

## Why Glicko-2 rather than Elo

Elo has one number. Glicko-2 has three: the rating (`mu`), the **deviation**
(`phi` — how unsure we are), and the **volatility** (`sigma` — how erratic
the player's results are).

`phi` is the one that matters here. A newcomer and a veteran can both sit at
1500, but one rating is a _guess_ and the other is _earned_. Elo cannot tell
them apart, so it either moves the newcomer too slowly — they spend weeks
matched against the wrong people, and quit — or moves the veteran too fast,
and one bad night wrecks a year of results.

Glicko-2 **widens phi when you have not played**, so a returning player is
re-placed quickly, and narrows it as evidence accumulates. That is exactly
the shape of a casual sports app: people play in bursts, vanish for a season,
and come back.

## The implementation is validated against Glickman's published example

A rating implementation that is subtly wrong still produces
plausible-looking numbers. Ratings go up when you win and down when you
lose, so every hand-written _"does this feel right?"_ test passes.

The only way to know it is actually correct is to reproduce the reference
figures. `glicko.test.ts` runs Glickman's own worked example (glicko2.pdf §3)
and asserts **mu ≈ 1464.06, phi ≈ 151.52, sigma ≈ 0.05999**.

Two details that are usually skipped:

- **The volatility root-find.** Most implementations substitute "just keep
  sigma constant", which deletes the entire mechanism that distinguishes a
  consistent player from an erratic one — i.e. most of the reason to choose
  Glicko-2 in the first place. The Illinois-algorithm solve is implemented,
  with an iteration guard so a non-converging root find cannot become an
  infinite loop inside a request.
- **Order independence.** All of a rating period's matches are applied
  together. If order mattered, two players who beat the same opponents on the
  same night would end up with different ratings purely because of the order
  the rows came back from the database. A test asserts forwards and reversed
  give identical results.

`phi` is also **capped at the default RD**. Without the cap, a long-absent
player's uncertainty grows without limit and the next result they post swings
their rating absurdly.

## Session capacity is double-booking, one level up

> **Removed (#511, 2026-10-13).** The session model this section describes
> (`OpenPlaySession`, `SessionParticipant`, `SessionChatMessage`,
> `usecases/session.ts`) was never wired to a route. Open play shipped in #376
> on the booking instead: `open_game` and `open_game_request`
> (`prisma/schema/open-play.prisma`, `usecases/open-play.ts`), where the
> booker accepts each player and the count is the booking's own. The text
> below is kept as the record of the design that was not used.

The obvious join:

```ts
const s = await db.openPlaySession.findUnique(...);
if (s.currentCount >= s.maxParticipants) throw new SessionFullError();
await db.sessionParticipant.create(...);
await db.openPlaySession.update({ currentCount: { increment: 1 } });
```

Four players tap "Join" on the last seat at once. All four read
`currentCount = 3`. All four pass the check. All four insert. A four-a-side
game now has seven people, and two of them drove across Sofia for nothing.

Same fix as the booking EXCLUDE constraint — make the **database** arbitrate:

```sql
UPDATE ... SET currentCount = currentCount + 1
WHERE id = $1 AND currentCount < maxParticipants
```

Atomic. It either increments or matches zero rows, and Postgres serialises
the writers. There is no read-then-write window to race in.

**Proven:** eight players race for four seats, every join started before any
is awaited. Exactly four are fulfilled, four get `SessionFullError`, and
`currentCount` matches the participant row count.

## The aborted-transaction trap, again

The double-join guard originally used `create()` and caught the unique
violation to give the seat back. **It could not work** — for exactly the
reason documented in P09: a constraint violation _aborts_ the Postgres
transaction, so the rollback command fails with "current transaction is
aborted".

The consequence here is nastier than in P09: a user double-tapping "Join"
would silently consume **two seats** and lock a real player out of the game.

`createMany({ skipDuplicates: true })` reports the conflict as a **count of
zero** instead of raising, which leaves the transaction healthy and the
rollback possible.

Worth noting this is the _second_ time the same trap appeared in a different
disguise. It is not an exotic edge case; it is what Postgres does.

## Leaving cannot drive the count negative

`leaveSession` only decrements when a row was **actually removed**.
Decrementing unconditionally lets someone spam "leave" and push
`currentCount` below zero — which then lets the session over-fill.

## Chat is sanitised on the way IN

Chat is the highest-risk surface in the product: text one user writes and
another user's _browser_ renders.

Sanitising only at render time means every future renderer has to remember —
and the one that forgets is a stored XSS. (See P06: the ported sanitiser had
a double-unescape bug that resurrected `<script>` tags. This is the field it
would have resurrected them into.)
