# What the privacy policy claims, and what backs each claim (#370)

The privacy policy in `content/legal/{bg,en}/privacy.md` is a draft for the owner's review
(2026-11-15), adapted from Agrent's notice. Every factual sentence in it should be one row
below. When the code changes what a row says, the policy changes in the same PR.

Paths are on `main` unless they start with `origin/feat/assistant:`. Google Calendar sync and
the assistant exist only on that branch (and Calendar also on `origin/feat/google-calendar`),
behind flags that default to off. The policy describes them as features that work "only when
switched on".

Section numbers are the policy's.

## 1. Controller

| Claim | Backed by |
| --- | --- |
| The controller is Inflect Ltd, VAT BG208694569 | Owner's instruction, 2026-11-15. Agrent's text does not name a company or an address, so the address and the Bulgarian form are placeholders. |
| Contact is ivo@inflect.bg | Owner's instruction, 2026-11-15. It is also Agrent's live contact address. |

## 2. What we collect

| Claim | Backed by |
| --- | --- |
| Sign-in is Google; Facebook is registered too | `src/auth.ts:137` (Google), `src/auth.ts:157` (Facebook); `tests/guardrails/production-sign-in-providers.test.ts`. Facebook is held back until the Meta app is Live (docs/legal-pages.md "Facebook"), so the text says "once we offer it". |
| Apple sign-in "once we offer it" | Native only: `src/app/api/v1/auth/token/route.ts` accepts `apple`; not in `src/auth.ts`. The owner says it is not offered yet. |
| Google gives us email, name and picture (`openid email profile`) | `docs/oauth-setup.md:67`; `email_verified` checked at `src/auth.ts:301` |
| We keep email, name and language; written only on the first sign-in | `src/app-layer/usecases/provider-account.ts:46-66` (`create`, `update: {}`) |
| The picture is our own copy: one small WebP, no metadata | `docs/media-storage.md:38`; the provider URL is never kept, `provider-account.ts:53-54` |
| No password, no provider access keys kept | No adapter or Account table, `src/auth.ts:217-241`; `passwordHash` is test-only (`src/auth.ts:184-210`) |
| Account kind: player, club or coach, one only | `prisma/schema/enums.prisma:23-27`; `User.accountKind` |
| Sports and a self-declared level 1 to 7 | `PlayerSportLevel`, `prisma/schema/auth.prisma:319-331` |
| The questionnaire keeps only the level, not the answers | `src/app-layer/usecases/skill-survey.ts:9-22` (answers in, level out; no answers column) |
| Settings: language, notifications, `searchable`, `ratingPublic` | `prisma/schema/auth.prisma:155,159-186,191,196` |
| Accepted texts: document, version, language, time | `LegalAcceptance`, `prisma/schema/auth.prisma:300-317` |
| Favourite venues | `FavouriteVenue`, `prisma/schema/venue.prisma:351` |
| No city, gender or date of birth collected from players | No player field for them. `PlayerProfile.dateOfBirth` exists but is never written (`src/lib/account/deletion-plan.ts`, `UNWRITTEN`). |
| The SMS code is sent and checked by Infobip; we do not keep it | `src/lib/sms/phone-verifier.ts:20-22` |
| The number is kept encrypted, with when it was confirmed | `src/app-layer/usecases/phone-verification.ts:282` (`encryptField`, `phoneVerifiedAt`) |
| A fingerprint stops one number confirming two accounts | `phoneHash @unique`, `prisma/schema/auth.prisma:146`; HMAC in `src/lib/account/phone-fingerprint.ts` |
| Bookings: club, court, time, price, booker, players, cancellations and reason, no-shows, notes | `prisma/schema/booking.prisma:8-115` (`notes` :39, `cancellationReasonJson` :54), `BookingParticipant.noShowAt` |
| The club records tags, no-show count, last played, credit | `prisma/schema/membership.prisma:15,18,19`; the credit ledger |
| Open games: note up to 280 characters, join requests | `prisma/schema/open-play.prisma:30-32,91` |
| Results and the level worked out from them | `docs/ranking.md:91-101` |
| Tournaments name the player and the partner | `src/lib/account/deletion-plan.ts` tournament entries; `docs/ranking.md` |
| Messages, blocks, reports | `prisma/schema/messaging.prisma:133-181`; `ContentReport`, `prisma/schema/moderation.prisma:85` |
| Reviews of venues and coaches | `src/app-layer/usecases/reviews.ts`, `src/app-layer/usecases/coach-reviews.ts` |
| Coach: description, qualifications, sports, lessons, certificate | `prisma/schema/coach.prisma:45-109,195-227` |
| Club: staff roles, invited staff emails, venue photos | `TenantMembership`, `Invite` (`prisma/schema/auth.prisma:377-404,499-522`); `docs/media-storage.md:3-5` |
| "For clubs" form: name, club name, phone or email, message, language; no IP | `ContactRequest`, `prisma/schema/notifications.prisma:239-256`; the limiter keys on an HMAC of the IP, `src/app-layer/usecases/contact-requests.ts:31,146` |
| Device: APNs token, device name, system version | `DeviceToken`, `prisma/schema/devices.prisma:26-43` |
| In-app notifications and the subject and text of sent emails | `Notification`; `EmailOutbox`, `prisma/schema/notifications.prisma:183` |
| IP used to limit requests | Key `ratelimit:<scope>:ip:<ip>…`, `src/lib/security/rate-limit-middleware.ts:205` |
| iPhone app sign-in keeps IP and kind of device | `src/app/api/v1/_lib/native-session.ts:38-40`; web sessions store neither |
| Usage counts are daily totals linked to nobody | `docs/usage-counts.md:12`; `tests/guardrails/usage-no-personal-data.test.ts` |

## 3. Purposes, bases, automated decisions

| Claim | Backed by |
| --- | --- |
| The legal bases listed | Drafted, not code. A lawyer should confirm them (open question). |
| No selling, no ads, no ad networks, no outside analytics | `docs/legal-pages.md` cookie audit ("no analytics or ads"); no analytics SDK in `package.json` |
| 3 no-shows in 90 days stop online booking at that club until the club lifts it | `NO_SHOW_BLOCK_THRESHOLD = 3`, `NO_SHOW_WINDOW_DAYS = 90`, `src/app-layer/usecases/booking-rules.ts:30,32` |
| Review text is checked by an AI model; clear cases refused, doubt or outage goes to a person | `src/lib/moderation/classify.ts:67,203` (`claude-haiku-4-5-20251001`); `src/app-layer/usecases/reviews.ts:132-149` |

## 4. Who sees what

| Claim | Backed by |
| --- | --- |
| A posted game shows first name, picture, note, venue, time, price to everyone, never email or phone | `src/app-layer/usecases/open-play.ts:72-75,211,454-456` |
| The player list is for the organiser, players and askers | `src/app-layer/usecases/open-play.ts:190-196` |
| The level is visible unless hidden; signed-in users see club rankings with full names | `docs/ranking.md:66-90`; `ratingPublic`, `prisma/schema/auth.prisma:196` |
| Tournament draws are for signed-in users | `src/app/api/v1/tournaments/[id]/draw/route.ts:12-20` |
| Search shows name, picture, sports, levels, and can be switched off | `searchable`, `prisma/schema/auth.prisma:191`; `src/app-layer/usecases/messaging.ts:1013-1018` |
| The club sees name, email, bookings, no-shows, credit, messages to it, its tags | `src/app/(app)/t/[slug]/admin/players/PlayersBoard.tsx:66,226-228`; club inbox RLS, `prisma/schema/messaging.prisma:21-28` |
| The club sees the phone only for an upcoming booking | `src/app/(app)/t/[slug]/admin/calendar/diary-day.ts:187-216` |
| A coach sees name, level, rating if allowed, phone only for an upcoming lesson | `src/app-layer/usecases/coach-lessons.ts:734,858-882`; `docs/coaches.md:35-37` |
| A coach review shows a short name | `shortName`, `src/lib/coaches/reviews.ts:9-10` |
| The certificate is hidden; only `COACH_APPROVE` holders open it; every opening is recorded | `docs/coaches.md:60-68`; `src/app/api/v1/platform/coaches/[userId]/certificate/route.ts:20-21` |
| Team access is personal, at most 90 days, every action recorded | `docs/platform-admin-runbook.md:12-30` (`:16`, the 90-day CHECK) |
| A moderator sees the reported message and the last 20 of the conversation, not the reporter | `CASE_CONTEXT_MESSAGES = 20`, `src/app-layer/usecases/moderation-messages.ts:41`; reporter hidden, `:22-23` |

## 5. Providers

| Claim | Backed by |
| --- | --- |
| Google Cloud, europe-west1 (Belgium): server, database, backups, photos | `docs/deploy-gcp.md:3-4,862,873-875`; `docs/media-storage.md:54`; bucket locations read with `gcloud storage buckets describe` on 2026-11-15 (both `EUROPE-WEST1`) |
| Apple gets the device key, title, text and a link | `src/lib/push/apns.ts:288-306` |
| Resend gets address, subject, plain text | `src/lib/email/provider.ts:141-150` |
| Infobip gets the phone number and the language | `src/lib/sms/phone-verifier.ts:102-142` |
| Anthropic gets review text | `src/lib/moderation/classify.ts:197-227`; the key is set in production, `docs/deploy-gcp.md:1032` |
| Meta: sign-in once offered | `src/lib/auth/facebook.ts:42,48` (`email public_profile`, `id,name,email,picture`) |
| Anthropic and Resend are in the USA; the transfer basis | The basis is a placeholder (open question). |
| No online payment today | `src/lib/stripe.ts:14-20` (no key in production); `onlinePaymentEnabled` defaults off, `prisma/schema/auth.prisma:62-69` |

## 6. Google

| Claim | Backed by |
| --- | --- |
| Sign-in asks only `openid email profile`, used only for the account | `docs/oauth-setup.md:67`; `provider-account.ts:46-66` |
| Calendar works only when switched on | `origin/feat/assistant:src/env.ts:152` (`GOOGLE_CALENDAR_SYNC` default `'0'`) |
| Scopes `calendar.app.created` and `calendar.freebusy` | `origin/feat/assistant:src/lib/google-calendar/oauth.ts:33,40` |
| One calendar named playerz | `origin/feat/assistant:src/app-layer/usecases/google-calendar-sync.ts:68,229` |
| Bookings, games, lessons, tournament matches; title, time, venue name and address, court, link | `origin/feat/assistant:src/app-layer/usecases/google-calendar-sync.ts:148-157,190-202`; `docs/google-calendar-sync.md` on that branch |
| No other players' names in events | Same lines: summary, location and description hold venue, court and link only |
| Free/busy only, primary and playerz calendars | `origin/feat/assistant:src/app-layer/usecases/google-calendar-sync.ts:458-461,521` |
| Used when a co-player asks the assistant; they learn only free or unknown | `origin/feat/assistant:src/app-layer/usecases/assistant-best-time.ts:184`; `docs/assistant.md` "Privacy" on that branch |
| The refresh token is encrypted | `origin/feat/assistant:src/app-layer/usecases/google-calendar.ts:270,277` (`encryptField`) |
| Also kept: Google email, scopes, calendar id | `origin/feat/assistant:prisma/schema/calendar.prisma:26-33` |
| Switching off revokes at Google and deletes the key; the calendar stays | `origin/feat/assistant:src/app-layer/usecases/google-calendar.ts:384-422` |
| Same on account deletion | `origin/feat/assistant:src/lib/account/deletion-plan.ts:602-608` |
| Not sold, not for ads, not for AI training | No such use in the code. It is a commitment the owner makes. |
| The Limited Use sentence | Google's required disclosure, quoted verbatim |

## 7. Assistant

| Claim | Backed by |
| --- | --- |
| Works only when switched on | `origin/feat/assistant:src/env.ts:403` (`ASSISTANT_ENABLED` default `'0'`) |
| For players and coaches | `origin/feat/assistant:src/app-layer/usecases/assistant-ask.ts:68` (`playsAsPlayer`: PLAYER or COACH) |
| Anthropic models | `origin/feat/assistant:src/app-layer/ai/assistant/config.ts:18,24` |
| Books nothing; proposes a draft | `docs/assistant.md` "What it does" on that branch |
| Up to 50 remembered things, 280 characters each, with the source sentence | `origin/feat/assistant:src/lib/assistant/memory-limits.ts:8,14`; `AssistantMemoryFact.sourceQuote` |
| A daily cost record | `AssistantSpend`; `origin/feat/assistant:src/app-layer/ai/assistant/config.ts:27` |
| Sent: question, up to 6 earlier turns, remembered things, search results with co-players' names and free/unknown | `origin/feat/assistant:src/app-layer/usecases/assistant-conversation.ts:17,19`; `docs/assistant.md` "Privacy" |
| Location is not sent | `origin/feat/assistant:src/app-layer/ai/assistant/prompt.ts:81,91` (only "shared: yes/no"); used server-side, `tools.ts:190` |
| Memory: 10 minutes after the conversation goes quiet, up to 5 new things | `origin/feat/assistant:src/app-layer/usecases/assistant-memory-sweep.ts:23`; `memory-extractor.ts:17` |
| A delete hides the item; the text is erased on account deletion | Soft delete, `origin/feat/assistant:src/app-layer/usecases/assistant-memory.ts:9,45`, `assistant-conversations-control.ts:37,79`; hard delete in `deletion-plan.ts:613` on that branch |

## 8. Notifications and emails

| Claim | Backed by |
| --- | --- |
| A message notification names the sender, never the text | `src/app-layer/usecases/messaging-notify.ts:127-134` |
| Each kind has its own switch | `push*` and `email*` fields, `prisma/schema/auth.prisma:159-186` |
| Fact of the week: Mondays from 10:00, players only, own switch | `SPORT_FACT_SEND_HOUR = 10`, `src/app-layer/usecases/sport-facts.ts:21,60,129-131`; `pushSportFacts`, `prisma/schema/auth.prisma:186` |
| Email kinds: confirmations, reminders, club changes, open games, messages, lessons taught | `src/lib/email/unsubscribe.ts:34-42`; call sites in `src/app-layer/usecases/booking-notifications.ts` |
| A message email: no sooner than 10 minutes, at most once an hour per conversation | `EMAIL_DELAY_MS`, `EMAIL_WINDOW_MS`, `src/app-layer/usecases/messaging-notify.ts:49,51` |
| Unsubscribe link in each email | `src/lib/email/unsubscribe.ts`; `src/app/(public)/email/unsubscribe/[token]` |
| Account emails without a switch | `src/app-layer/usecases/coach-approval.ts:509`; `coach-link-notifications.ts:117,175` |
| Plain text, no tracking images, no advertising emails | `src/lib/email/provider.ts:40,146` (text only); no marketing category exists |

## 9. Location and maps

| Claim | Backed by |
| --- | --- |
| Coordinates are used only for the search and not stored | `src/app/api/v1/venues/near/route.ts:61-74`; the request log records the route, not the query, `src/lib/errors/api.ts:162` |
| Venue plans are drawn from OpenStreetMap data, no tiles loaded | `src/lib/venues/plan.ts:73-74`; `maplibre-gl` imported nowhere in `src/` |
| "Directions" opens Google Maps with the venue address | `src/app/(public)/me/bookings/[id]/directions.ts:20` |
| Photos load from Google Cloud Storage, which sets no cookies | `src/lib/media/config.ts:27`; `docs/legal-pages.md` cookie audit |

## 10. Protection

| Claim | Backed by |
| --- | --- |
| Phone, messages and two-factor secrets encrypted with AES-256-GCM | `src/lib/security/encryption.ts:4,12`; phone `phone-verification.ts:282`, messages `messaging.ts:1253`, two-factor `src/lib/auth/mfa.ts:284` |
| Certificate and calendar key encrypted | `docs/coaches.md:60-65`; calendar row above |
| Email and phone fingerprints are one-way | `src/lib/account/no-show-fingerprint.ts:28-60` (HMAC-SHA256); `phone-fingerprint.ts:59-64` |
| Metadata removed from uploaded photos | `docs/media-storage.md:17` |
| Servers, database and backups in the EU | section 5 rows |
| Changes by the team need a second factor | `docs/platform-admin-runbook.md:84-86` |

## 11. Retention

| Claim | Backed by |
| --- | --- |
| Profile, messages, notifications, sent emails, reviews, devices kept while the account exists | No purge job for them; removed by the deletion plan, `src/lib/account/deletion-plan.ts` (`EmailOutbox` :591, `DeviceToken` :607) |
| iPhone sessions with IP kept until the account is deleted | No purge of `user_session`; `deletion-plan.ts:147-163` |
| Bookings and payments stay without a name; no end date today | `deletion-plan.ts:307-350` |
| No-shows after deletion: up to 90 days from each | `purgeLapsedNoShowCarries`, `src/app-layer/usecases/no-show-carry.ts:161-167`, run every minute by `src/app/api/cron/complete-ended-bookings/route.ts:82`; `NO_SHOW_WINDOW_DAYS = 90` |
| Certificate: while active; deleted when stopped or on deletion; 30 days on an unchanged draft or declined profile | `DRAFT_CERTIFICATE_KEPT_DAYS = 30`, `src/lib/coaches/certificate-limits.ts:33`; `src/app-layer/usecases/coach-certificate-retention.ts:33,58`; `coach-approval.ts:423` |
| IP for abuse protection: 2 hours at most | Redis TTL `windowMs + lockoutMs`, `src/lib/security/rate-limit.ts:283`; the longest IP-keyed limits are `API_KEY_CREATE_LIMIT` and `TENANT_CREATE_LIMIT` (1 h + 1 h), `:438,475` |
| Logs rotated by size | `max-size: '10m'`, `max-file: '3'`, `deploy/docker-compose.prod.yml:42-43` |
| "For clubs" enquiries kept until a request | `deletion-plan.ts:612`; no purge job |
| Accepted texts and booking history kept after deletion | `deletion-plan.ts:140` (`LegalAcceptance`), `:676-690` (`AuditEntry`) |
| Backups: dump 30 days plus 7 days soft delete; disk snapshot 14 days; gone within 37 days | `docs/deploy-gcp.md:861-862,873-875`; bucket lifecycle read on 2026-11-15 (`Delete` at age 30) |

## 12. Deletion

| Claim | Backed by |
| --- | --- |
| Self-service, immediate, final, no waiting period | `src/app/api/v1/me/route.ts:99-130`; `src/app-layer/usecases/account-deletion.ts:21`; trigger `app_user_tombstone_final`, `deletion-plan.ts:135-137` |
| Refused with upcoming bookings, lessons or tournaments | `messages/*.json` `profile.delete.blocked.*`; `account-deletion.ts` |
| Club accounts deleted on request | `docs/platform-admin-runbook.md:705-735` |
| Deleted: name, phone, picture, sports, notifications, email settings, reviews, invite links, memberships and tags, favourites, blocks, devices, sessions, message text | `deletion-plan.ts` (tombstone :72-103, tags :263, chat body :860-866, avatar :939-951) |
| The reports you filed are deleted (unlike Agrent, which keeps them under the DSA) | `deletion-plan.ts:546-574` (`ContentReport` deleted, `ModerationCase.reportedByUserId` nulled) |
| Email replaced, so the address can sign up again | `deleted-<id>@deleted.playerz.invalid`, `deletion-plan.ts:76` |
| Bookings stay as "Deleted user"; payments and credit stay; credit lost | `deletion-plan.ts:307-350`; `messages/*.json` `deleteAccountHelp.kept.*` |
| Booking history stays, no IP in it | `deletion-plan.ts:683-687` (the IP column is never written) |
| No-shows carried on email and phone fingerprints, move to a new account with the same email or phone | `deletion-plan.ts:278-299`; `provider-account.ts:120-127`; `phone-verification.ts:293` |
| Results stay without a name | Match and tournament rows kept against the tombstone, whose name is cleared |

## 13. Export

| Claim | Backed by |
| --- | --- |
| Profile → Privacy → Download my data, one JSON file | `src/app/api/v1/me/export/route.ts:14,59`; `messages/*.json` `profile.data.download` |
| What it contains | `src/app-layer/usecases/data-export.ts:14-38,132-419` (format version 11 on `main`, 13 on `origin/feat/assistant`) |
| What it leaves out: credentials, others' contact details, club tags | `tests/helpers/export-excluded.ts`; `tests/guardrails/data-export-excludes-secrets.test.ts`; `data-export.ts:56-61` |
| 10,000 rows per kind at most | `EXPORT_ROW_CAP = 10_000`, `data-export.ts:81` |

## 14–16. Rights, children, changes

| Claim | Backed by |
| --- | --- |
| Name and sports edited in Profile; email comes from Google | `src/app-layer/schemas/me.ts:58-80` |
| Answer within one month | GDPR Art. 12(3); a commitment, not code |
| КЗЛД, https://www.cpdp.bg | The Bulgarian supervisory authority |
| No age check today | No age gate in the code; `PlayerProfile.dateOfBirth` is never written |
| A material change is shown and accepted once; a typo fix keeps the version | `src/lib/legal/versions.ts`; `docs/legal-pages.md` "Versions" |
