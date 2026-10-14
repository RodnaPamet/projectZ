# The coaches module (#377)

Players book a lesson with a coach on a club's court. The owner's decisions
are numbered on #377 (1–28); the issues that built it are #545–#552 and #557.
This page is for whoever runs the platform: what switching it on changes,
what has to be in place first, and where its data lives.

## What the switch does

`MODULE_COACHES=1` in the app's environment (`src/lib/modules.ts`). Default off.
Read on every request, so it takes effect on a restart, not a rebuild.

**Switching it on only shows things.** Every coach route and API answers either
way. With it on:

- players get «Треньори» in the navigation, and `/coaches` goes into the sitemap;
- a venue page lists the coaches you can book there;
- a coach account gets «Профил на треньор» (`/me/coach`) in its navigation and
  its profile;
- a club's owners and managers get «Треньори» in the club admin.

With it off, nobody sees a link, but the pages still load for anybody who has
the address. Production has it off; staging has it on.

## Before switching it on in production

1. **Somebody can approve coaches.** A coach is not listed until the platform
   owner has approved their profile and certificate. Give that person
   `COACH_APPROVE`, with a second person as the grantor. Both must be real
   accounts. See `docs/platform-admin-runbook.md` → "Approving coaches (#545)".
   The approver signs in with a second factor.
2. **The privacy text covers coaches (#370).** It needs to say:
   - the certificate is kept privately and seen only by the platform owner;
   - how long the certificate is kept (decisions 17 and 28, below);
   - what a coach sees of a player who booked them: the name, the level the
     player gave for that sport, and, for lessons still to come, the phone
     number the player confirmed (decision 12).

   This is the owner's text to write.

3. **Somebody reads the moderation queue.** Reviews of coaches go to the same
   queue as reviews of venues (`REVIEW_MODERATE`). If `ANTHROPIC_API_KEY` is
   not set, every review with text waits there for a person.
4. **The browser tests run with the module on.** `playwright.config.ts` sets
   the switches its server runs with. Add `MODULE_COACHES: '1'` there, and add
   a check to the venue-page journey that the coaches section is shown.

Then, on the VM:

```bash
echo 'MODULE_COACHES=1' | sudo tee -a /opt/playerz/.env >/dev/null
cd /opt/playerz && sudo docker compose -f docker-compose.prod.yml up -d --force-recreate playerz-app
```

To switch it off again, remove the line and recreate the container. Nothing
is lost; the links just disappear again.

## Certificates

- **Where.** `coach_certificate`, one row per coach, in the database rather
  than the media bucket. The file is **sealed** with AES-256-GCM, under a key
  derived (HKDF) from `DATA_ENCRYPTION_KEY` that is used for nothing else
  (`src/lib/coaches/certificate.ts`). That makes it unreadable in a backup
  unless you also have that key. Rotating `DATA_ENCRYPTION_KEY` without
  re-sealing makes every stored certificate unreadable.
- **Who.** Only someone with the `COACH_APPROVE` capability, from the platform
  queue. Every download writes an audit row. A club never sees it, and
  neither does a player or the coach.
- **How long.**
  - Kept while the coach is active (decision 17).
  - Deleted when the platform stops a coach, or when the coach deletes their
    account.
  - On a profile that has been DRAFT or DECLINED for 30 days with no change,
    the certificate is deleted by the daily `sweep-orphan-media` run
    (decision 28, #557). The coach's profile page warns about this first.
    That run also reports how many certificates are stored and their total
    size, so growth shows in the container log.

## What a coach is sent

Lessons booked, cancelled by someone else, and the reminder about three hours
before. Each goes to the bell, and by email under the coach's own setting
«Уроци, които водя» (decision 22). Answers from a club (accepted, declined,
ended) and from the platform (approved, declined, stopped) always go to the
bell and by email. The club's owners and managers are told when a coach asks
to teach there: at most one email a day per request.

## Rolling back

Rolling back past P72, P73 or P74 means parking first. Each added enum values
that the previous image cannot read: the coach-approval values (P72),
notification kinds (P73) and a moderation subject (P74). The steps are in
`docs/deploy-gcp.md` → "Rolling back past p72" / "p73" / "p74". Rolling back
past P71 needs nothing: the image before it never reads the coach tables, and
they stay where they are.
