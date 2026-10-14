# The ranking module (#378)

Players report the results of the bookings they played; ratings move from
them and show as a level from 1 to 7. The owner's decisions are numbered on
#378 (29–49). The issues that built it are #574–#578 and #582; tournaments
(#579–#581) come next and get their own section here when they ship. This
page is for whoever runs the platform: what switching it on changes, how a
result moves, and where its data lives.

## What the switch does

`MODULE_RANKING=1` in the app's environment (`src/lib/modules.ts`). Default
off. Read on every request, so it takes effect on a restart, not a rebuild.

**Switching it on only shows things.** Every result route and API answers
either way. With it on:

- a completed booking's page has «Резултат»: report it, or confirm or dispute
  what the other side reported;
- the club admin gets «Резултати»: the disputed results to decide, and the
  recent ones;
- the diary's sheet for a completed booking takes the club's own entry, or a
  karting track's finishing order;
- every card that shows a player's level (player search and card, open play's
  requests, a coach's lessons) shows the rated level beside the declared one,
  and a game in Игри says «За вашето ниво» to a viewer whose level fits it;
- the player's profile gets «Класиране» (level, points, matches) and the
  «Показвай нивото ми» switch;
- a club's page gets its leaderboard, for signed-in players.

With it off, every screen shows the declared level as before, and nothing
above is linked. Results that arrive through the API are still counted.

## A result, start to finish

1. **Reported.** A player on a completed booking reports it within 7 days of
   the end (decisions 29, 45). They pick the two sides from the booking's
   players (30) and enter the score (46):
   - sets and games for racket sports and volleyball: one to five sets, none
     level, and the side that won more sets wins;
   - one total for everything else: goals, points, or the game. A draw is
     allowed where the sport has draws (football, chess), not in basketball.

   The other side is told by bell, push and email (the booking-email switch).

2. **Answered.** A player on the other side confirms it, or disputes it with a
   note for the club. If nobody answers within 48 hours, it confirms itself.
   The five-minute `send-booking-reminders` cron does that
   (`confirmedResults` in its response). The VM's sweep overlay needs nothing
   new.
3. **Disputed.** The club's desk (`bookings.view_all`) is told by bell, push
   and email, and decides on «Резултати» (34). It can confirm the result as
   reported, correct it and confirm that, or void it. The players are told.
4. **Entered by the club.** The desk can enter a result from the diary. It is
   final (the default from round 4). A karting track enters the session's
   finishing order instead (33). Nobody confirms it, and each driver is told
   their place.

A confirmed or decided result is **counted once**: one row in `match_result`
keyed `booking:<id>`, a `match_participant` row per player, and a
`skill_rating_history` row per living player. A voided result counts for
nothing. Counting the same booking twice is a no-op. The rating engine is
OpenSkill for sports with sides and for karting's races, and Glicko-2 for
chess.

## What a rating shows

- **Everyone** sees the level, one decimal, on the 1–7 scale (31). It starts
  at the level the player declared (Q24) and moves with confirmed results.
- **«(неокончателно)»** marks a level under 5 confirmed matches, or after six
  months without one (47, 48).
- **Time away** grows the uncertainty the next match starts from. The level
  stays where it was, and the next results move it faster. After a year away
  the uncertainty is back to a newcomer's.
  The constants are in `src/lib/ratings/levels.ts`.
- **Only the player** sees the engine's points and the record behind them,
  on their own profile (`GET /me/ratings`).
- **Opted out** («Показвай нивото ми» off, `app_user.ratingPublic`; 36):
  - still rated, and the player still sees it on their own page;
  - their own rating still drives the «За вашето ниво» hint;
  - everyone else sees the level they declared, as before ranking;
  - they are left off every leaderboard.
- **Leaderboards** (35) are per club and sport. A player is on one with:
  - a counted result at that club;
  - a settled level;
  - the level not hidden;
  - no block either way with the viewer.

  They show full names, to signed-in players only (49). The club page shows
  a signed-out visitor a sign-in prompt instead.

## Where the data lives

- `match_report` (P78): one per booking. It holds the sides, the score, the
  status, and who reported, answered and decided it. It is the club's row,
  under the tenant's RLS.
- `match_result` and `match_participant`: the counted matches, global.
- `skill_rating_history`: one row per player per counted match, global, with
  no RLS. Opting out is enforced in code (`src/app-layer/usecases/shown-ratings.ts`).
- `player_sport_level`: the declared level, owner-only under RLS. The rating
  starts there.

**Deleting an account (#582)**:

- its rating history goes;
- the results it played stay for the other players, with it shown as
  «Изтрит потребител»;
- a result counted after the deletion still rates the others against where
  the deleted player stood, and writes nothing for them.

`DELETION_PLAN` and `NEW_ROWS` in `src/lib/account/deletion-plan.ts` say so
column by column. P79's triggers refuse a deleted account as the reporter or
the answerer of a new result.

**The data export** (version 9) has a `ranking` section:

- the setting;
- each sport's rating with its points;
- every rating change;
- the results the person played, with only how many players were on each of
  the other sides.

## Before switching it on in production

1. **The privacy text covers ratings (#370).** It needs to say:
   - that results move a public level;
   - that the points are private;
   - how to hide the level;
   - that leaderboards show full names to signed-in players.

   This is the owner's text to write.

2. **The browser tests run with the module on.** `playwright.config.ts` turns
   it on for the result journeys (`tests/e2e/results.spec.ts`).
3. **Staging has had it on.** Try a report, a dispute and the club's decision
   there with two accounts.

Then, on the VM:

```bash
echo 'MODULE_RANKING=1' | sudo tee -a /opt/playerz/.env >/dev/null
cd /opt/playerz && sudo docker compose -f docker-compose.prod.yml up -d --force-recreate playerz-app
```

To switch it off again, remove the line and recreate the container. Results
already reported and ratings already moved stay. They just stop showing.

## Rolling back

- **Past P79:** park first. P79 added three notification kinds the previous
  image cannot read. The steps are in `docs/deploy-gcp.md` → "Rolling back
  past p79".
- **Past P78:** needs nothing. The image before it never reads
  `match_report`, and the table stays where it is.
