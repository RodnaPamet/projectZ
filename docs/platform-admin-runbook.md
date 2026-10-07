# Platform admin: break-glass runbook

Platform authority is a row in `platform_admin_grant`. It expires on its own, it
cannot be extended, and there is **no way to grant it through the app**. Those are
deliberate choices with a cost, and this document is that cost written down.

Read this before you need it. The situation it covers is one where you are already
having a bad night.

---

## What a grant is

| Property                         | Enforced by                                          |
| -------------------------------- | ---------------------------------------------------- |
| expires, at most 90 days out     | `CHECK platform_admin_grant_expiry_cap`              |
| cannot be granted to yourself    | `CHECK platform_admin_grant_no_self_grant`           |
| needs a reason of 12+ characters | `CHECK platform_admin_grant_reason_stated`           |
| at least one capability          | `CHECK platform_admin_grant_capabilities_nonempty`   |
| one live grant per person        | `platform_admin_grant_one_live_idx` (partial unique) |
| immutable except one revocation  | `platform_admin_grant_immutable_trg`                 |

All six are in the **database**, not in application code. You cannot work around
them from the app, and neither can an attacker who takes over an admin session.

Every use writes a row to `platform_audit_entry`, which is append-only and whose
attribution trigger refuses any row not matching the admin bound on that
transaction. You cannot act as platform admin without leaving a record, and you
cannot edit the record afterwards.

---

## Running the commands at all

Every command below is `npm run grant:platform-admin -- …`, and the `--` is
required: it is what passes the flags to the script rather than to npm.

An earlier version of this document said `tsx scripts/grant-platform-admin.ts`.
**That fails with `command not found`** — `tsx` is a local devDependency, not on
`PATH` and not installed globally. Which is the worst possible bug for a
break-glass runbook to have, since the first time anybody finds out is the one
night they need it. Verified by running it.

If you are somewhere `npm` is unavailable, `npx tsx scripts/grant-platform-admin.ts`
is the equivalent.

## Granting

Needs `DIRECT_DATABASE_URL` — the **owner** connection. That credential is
strictly more authority than any grant it issues, which makes whoever holds it
the real bar for platform access.

```bash
npm run grant:platform-admin -- \
  --user alice@playerz.bg \
  --granted-by bob@playerz.bg \
  --capabilities TENANT_READ,AUDIT_READ \
  --expires 2026-11-01 \
  --reason "incident response rota Q4"
```

Nothing has a default. A default expiry becomes the expiry everybody uses, and a
default reason is no reason at all.

`--granted-by` must be a **different** real account. The database refuses a
self-grant, so the first grant is two-party by construction and nobody can
bootstrap themselves.

### Capabilities

| Capability        | Status                                                     |
| ----------------- | ---------------------------------------------------------- |
| `TENANT_READ`     | read any club's operational data                           |
| `AUDIT_READ`      | read any club's audit log                                  |
| `USER_READ`       | read user records across clubs                             |
| `TENANT_SUSPEND`  | **declared, refused at the binding**                       |
| `REVIEW_MODERATE` | work the review moderation queue — an enabled write        |
| `CLUB_FEE_MANAGE` | set a club's fee and free period (#372) — an enabled write |

**Every write needs a second factor (#262).** A write capability is usable only
from a session that has stepped up with its holder's authenticator in the last
**15 minutes** — see [Two-step verification](#two-step-verification) below. A
grant holder who has not enrolled cannot use a write capability at all. Reads
(`TENANT_READ`, `AUDIT_READ`, `USER_READ`) need no step-up.

`TENANT_SUSPEND` is refused outright even with a step-up: taking a club offline
is a power nobody has decided to ship. Granting it today buys nothing. If you need
a cross-club write, that is a decision to make deliberately, not a flag to flip
during an incident.

`REVIEW_MODERATE` is that decision, made once, for one narrow write (#228): a club
must not moderate reviews of itself, so platform moderators work the queue. It is
enabled by name in `STEP_UP_PLATFORM_WRITES` (`src/lib/platform/capabilities.ts`),
which states the terms — it changes a review's visibility and the venue rating
computed from it, deletes nothing, and audits every decision with the moderator's
own note. Until #262 it was the one write admitted without a second factor; that
exception has ended, and the "writes without MFA" list no longer exists at all.
Every other write, present or future, is still refused unless it is added there
too.

### Club fees and invoicing (#372)

The owner invoices each club monthly from `/platform/fees`, outside playerz. The
page needs `TENANT_READ` to read, and `CLUB_FEE_MANAGE` to change a club's terms;
grant both to whoever invoices:

```bash
npm run grant:platform-admin -- \
  --user owner@playerz.bg \
  --granted-by bob@playerz.bg \
  --capabilities TENANT_READ,CLUB_FEE_MANAGE \
  --expires 2026-12-31 \
  --reason "monthly club fee invoicing Q4"
```

`CLUB_FEE_MANAGE` is a write: like `REVIEW_MODERATE`, it is enabled by name in
`STEP_UP_PLATFORM_WRITES` and needs a step-up from the last 15 minutes. It sets
two things per club, the fee percentage (0–30, two decimals) and the first day
the fee is charged (the free period ends the day before). A change applies to
bookings completed AFTER it; every fee line already written keeps its rate. It
is audited twice, `PLATFORM_CLUB_FEE_TERMS_SET` here and
`CLUB_FEE_TERMS_CHANGED` in the club's own log with the terms before and after.
New clubs get the same two values from the onboarding spec
(`docs/onboarding/runbook.md`).

The page asks for a reason first, written with every read. For each club it shows
the month's online bookings played, their revenue, the fee due and the free
period, with a link to the statement as the club sees it and its CSV. The same
over HTTP:

```
GET /api/v1/platform/fees?month=2026-10&reason=<why>
GET /api/v1/platform/fees/{clubId}/statement?month=2026-10&reason=<why>
GET /api/v1/platform/fees/{clubId}/statement/csv?month=2026-10&reason=<why>
PUT /api/v1/platform/fees/{clubId}/terms   {"feePercent":"10","feeStartsOn":"2027-01-01","reason":"…"}
```

**After the first deploy of #372**, write the lines for bookings completed before
it (the sweep repairs only the last 7 days by itself). It is idempotent; run the
dry run first:

```bash
npm run backfill:club-fees -- --dry-run
npm run backfill:club-fees
```

### Moderating reviews

Give moderators `REVIEW_MODERATE` alone — it does not need, and should not bring,
`TENANT_READ`:

```bash
npm run grant:platform-admin -- \
  --user moderator@playerz.bg \
  --granted-by bob@playerz.bg \
  --capabilities REVIEW_MODERATE \
  --expires 2026-12-31 \
  --reason "review moderation rota Q4"
```

**The moderator must then enrol a second factor** — `/platform/security`, within
15 minutes of signing in (see below). Until they do, the queue answers
`MFA_ENROLMENT_REQUIRED` and shows nothing.

The queue is the page `/platform/moderation`. It asks for a code from the
moderator's authenticator first (a step-up, good for 15 minutes on that device),
then for a reason once (written
with every page it loads) and a note for every decision (kept on the case as the
answer to "why", and written as the audit reason). The same two operations exist
over HTTP for tooling:

```
GET  /api/v1/platform/moderation/cases?reason=<why>[&cursor=<opaque>]
POST /api/v1/platform/moderation/cases/{id}/resolve   {"decision":"APPROVE"|"REJECT","note":"…"}
```

Both answer `403 STEP_UP_REQUIRED` until the calling session has stepped up
(`POST /api/v1/me/mfa/step-up {"code":"123456"}`), and again once its 15 minutes
are up.

**Why the queue fills up.** Every review with text is classified by the Claude API
before it is shown. When `ANTHROPIC_API_KEY` is unset, or the API is down, the
review is held for a human rather than published unchecked — so without a key,
every text review lands here. Star-only reviews are never queued.

---

## Two-step verification

Every cross-club **write** — today, the moderation queue — needs a fresh proof
from the admin's authenticator app, bound to the session that made it (#262).

| Property                                    | Where it is enforced                                     |
| ------------------------------------------- | -------------------------------------------------------- |
| TOTP seed is ciphertext at rest             | `encryptField` + CHECK `app_user_mfa_secret_is_envelope` |
| a step-up lasts 15 minutes, not sliding     | `MFA_STEP_UP_WINDOW_SECONDS`, read in the binding        |
| a step-up belongs to one session            | `user_session.mfaVerifiedAt`, checked in the write's tx  |
| a code is accepted once (no replay)         | `app_user.mfaLastUsedStep`, conditional UPDATE           |
| a recovery code is spent once               | `mfa_recovery_code.usedAt`, conditional UPDATE           |
| 5 guesses / 15 min (+5 min lockout), 50/day | `MFA_VERIFY_LIMIT`, `MFA_VERIFY_DAILY_LIMIT`, per user   |
| every attempt is recorded, append-only      | `account_security_event`, `…_append_only_trg`            |

### How an admin enrols

1. Hold a live grant (any capability). Enrolment is closed to everyone else.
2. **Sign in afresh**, then open `/platform/security` within 15 minutes. The
   first enrolment is trust-on-first-use, so a session older than that is
   refused with "sign out and sign in again" — a stolen cookie alone cannot
   plant an authenticator on an admin who has not enrolled yet.
3. "Start setup" shows the key. On a phone, "Open in authenticator app" adds it
   directly; on a laptop, type the key into the app as a time-based account.
4. Type the six-digit code the app shows. Two-step verification is now on, the
   session is stepped up, and **ten recovery codes are shown once**. Save them.

Over HTTP: `POST /api/v1/me/mfa/enrolment`, then
`POST /api/v1/me/mfa/enrolment/confirm {"code":"123456"}`.

An enrolled admin cannot re-enrol from the app — swapping in a new phone would
let a stolen, stepped-up session replace the owner's authenticator with its own.
A new phone is an operator reset (below). Recovery codes can be regenerated from
`/platform/security` after a step-up; every old code stops working.

### Recovering a locked-out admin

Lost phone **and** no recovery codes left. This is an ops procedure on the owner
connection (`DIRECT_DATABASE_URL`), and it has one step nothing can automate:
**confirm it is really them** — a call on a number you already had, in person,
or through the second person who issued their grant. A reset hands two-step
verification to whoever enrols next, so a reset requested by a stranger who
sounds like the admin is the attack.

Then, in one transaction:

```sql
BEGIN;

-- 1. Who, exactly. One row, or stop.
SELECT id, email, "mfaEnabledAt" FROM app_user WHERE email = 'alice@playerz.bg';

-- 2. Turn the factor off and void every code.
UPDATE app_user
   SET "mfaSecret" = NULL, "mfaEnabledAt" = NULL, "mfaLastUsedStep" = NULL
 WHERE id = '<id from step 1>';
DELETE FROM mfa_recovery_code WHERE "userId" = '<id>';

-- 3. Sign them out everywhere, which also ends every step-up they hold.
--    (A stepped-up session would already be refused — the binding checks
--    mfaEnabledAt as well — but a reset should leave nothing behind.)
UPDATE user_session SET "revokedAt" = now()
 WHERE "userId" = '<id>' AND "revokedAt" IS NULL;

-- 4. Say who did it and why. The log is append-only; this row is permanent.
INSERT INTO account_security_event (id, "userId", action, "detailsJson")
VALUES (gen_random_uuid()::text, '<id>', 'MFA_RESET_BY_OPERATOR',
        jsonb_build_object('operator', 'bob@playerz.bg',
                           'reason',   'lost phone, identity confirmed by call 2026-10-03'));

COMMIT;
```

They then sign in and enrol again, as above, within 15 minutes of signing in.

If the reset is because the admin may be **compromised** rather than locked out,
revoke their grant first (see [Revoking](#revoking)) and reset afterwards.

### Reading the security log

```sql
SELECT "createdAt", "userId", action, "userSessionId", "ipAddress", "detailsJson"
  FROM account_security_event
 ORDER BY "createdAt" DESC
 LIMIT 50;
```

`MFA_STEP_UP_FAILED` in a burst, or `MFA_STEP_UP_RATE_LIMITED` at all, is
somebody guessing codes on a live session of that account — treat it as a
compromised session: revoke the grant, then sign the account out everywhere.
`MFA_RECOVERY_CODE_USED` that the admin does not recognise means their codes
have leaked.

---

## Who holds authority right now

```bash
npm run grant:platform-admin -- --list
```

Needs no `--granted-by` and no `--reason`: reading is not an act that needs
justifying or a second party.

Start here. The audit query at the bottom of this document records **actions** —
every grant and revocation ever — and reconstructing current state from a log of
mutations is the arithmetic you should not be doing at 03:00. `--list` also marks
a grant that has **lapsed but not been revoked**, which is the trap the section
below covers.

## Revoking

```bash
npm run grant:platform-admin -- \
  --revoke alice@playerz.bg \
  --granted-by bob@playerz.bg \
  --reason "rota ended"
```

**Takes effect on their next request.** The grant is re-read from the database
every time and is never cached in a token, so there is no window where a revoked
admin keeps working until something expires.

This is the fast path during a suspected compromise. Use it first and ask
questions afterwards — a revoked grant costs one CLI call to reissue.

**You can do this alone.** `--granted-by` here records who revoked, and it may be
yourself; the two-party rule applies to issuing authority, not to taking it away.
Nothing about revocation should wait for a second person.

---

## When a grant lapses mid-incident

The failure this runbook exists for.

`warn-expiring-platform-grants` runs daily and logs `platform grant expiring`
with `hoursRemaining` inside a 7-day horizon. If you are reading this _because_
a grant already lapsed, that warning was missed.

**What you will see:** the platform route returns 403 with no explanation, and it
will look like the route is broken rather than like your authority ended.

**What NOT to do:** open a `psql` prompt and edit the row. Two reasons, both
concrete rather than moralising:

1. `platform_admin_grant_immutable_trg` will refuse you. You cannot move
   `expiresAt` or widen `capabilities` — by design, because otherwise the 90-day
   cap is advisory.
2. The lapsed grant still occupies the one-live-grant slot, so a new grant will
   be refused by the partial unique index until the old one is revoked. Working
   around that means dropping a constraint, and a constraint dropped at 03:00
   does not get put back.

**What to do — two commands, in this order:**

```bash
# 1. revoke the lapsed grant to free the slot
npm run grant:platform-admin -- \
  --revoke alice@playerz.bg --granted-by bob@playerz.bg \
  --reason "lapsed during incident 2026-09-25"

# 2. issue a short one
npm run grant:platform-admin -- \
  --user alice@playerz.bg --granted-by bob@playerz.bg \
  --capabilities TENANT_READ --expires <tomorrow> \
  --reason "incident 2026-09-25 — expires tomorrow"
```

Make the incident grant **short**. An incident grant with a 90-day expiry is how
a temporary permission becomes permanent.

A bare `YYYY-MM-DD` means the **end** of that day, UTC. It used to mean the start
— so `--expires <tomorrow>` typed at 23:30 produced a thirty-minute grant, and
`--expires 2026-11-01` from Sofia expired at 02:00 local, dead for the working day
it was meant to cover. Both measured. Pass a full ISO timestamp if you want a
precise instant; the CLI warns if the window is under two hours, because the
expiry job runs daily and cannot warn about a grant that short.

**Only the second command is two-party.** `--revoke` is not: the no-self-grant
CHECK applies to issuing a grant, not to ending one, so one person can revoke —
including revoking their own grant. Verified by doing it.

That distinction matters more than it sounds. An earlier version of this document
said both commands needed two people, which would have told a lone on-call they
were blocked from **revocation** — the fast path during a suspected compromise,
and the one thing you should never hesitate over. Revoke first, alone, and find a
second person afterwards for the reissue.

So: revoking needs one person with `DIRECT_DATABASE_URL`. Reissuing needs that
person plus somebody else to name as `--granted-by`. Worth knowing **before** the
incident which of those you can reach.

---

## If nobody can grant

The honest answer: you are blocked, and that is the trade you accepted when you
chose CLI-only granting over an in-app route.

The reasoning still holds while you are blocked: with an in-app grant path, a
stolen admin session mints a second admin and survives revocation of the first.
The compromise becomes self-healing. Without one, it is bounded by the single
grant it holds.

What to do about it is an **organisational** fix, not a technical one — make sure
at least two people who can be the granter, and at least one who holds
`DIRECT_DATABASE_URL`, are reachable out of hours. If that is not true today,
fix it now rather than during the next incident.

---

## Reading the audit trail

```sql
SELECT "createdAt", "actorUserId", action, capability, "subjectTenantId", reason,
       "detailsJson"
  FROM platform_audit_entry
 ORDER BY "createdAt" DESC
 LIMIT 50;
```

`detailsJson` is in that list deliberately. For `PLATFORM_GRANT_ISSUED` and
`PLATFORM_GRANT_REVOKED` the `capability` column holds only the **first** of the
grant's capabilities — it is a single-valued enum column and a grant may carry
several. Reading `capability` alone on a lifecycle row tells you `TENANT_READ`
about a grant that also carried `AUDIT_READ`. The full list is in
`detailsJson.capabilities` / `detailsJson.revokedCapabilities`, which is
authoritative for those two actions.

For every other action the row describes one capability being exercised, and
`capability` is exactly right.

`PLATFORM_GRANT_ISSUED` and `PLATFORM_GRANT_REVOKED` are written by the CLI;
everything else is written by `runAsPlatformAdmin` before the work it describes.

A club does **not** see platform access in its own audit log — an owner decision.
So a club cannot distinguish "nobody looked" from "somebody listed every club
including mine". If a customer contract ever requires that disclosure, the shape
of the answer changes and so does the schema.

---

## Reading it over HTTP

The SQL above is the break-glass path and needs a database shell. There are now
two routes, for when you have a session and not a psql prompt:

```
GET /api/v1/platform/audit?reason=<why>[&cursor=<opaque>]     needs AUDIT_READ
GET /api/v1/platform/tenants?reason=<why>[&cursor=<opaque>]   needs TENANT_READ
```

Three things to know before you use them.

**`reason` is required**, at least 12 characters, and it is written verbatim
into the row. There is no default: a reason the server invented would satisfy
the minimum and tell whoever reads the row in six months nothing. Send the
ticket number.

**Reading the audit log writes to the audit log.** Every page of every read
leaves its own `PLATFORM_AUDIT_READ` row. That is deliberate — an audit reader
that exempted itself could not answer "who has been looking at who looked at
what" — so expect your own reads in the results, and expect the table to grow
while you page.

**Follow `nextCursor` to the end.** The audit route returns 50 rows a page and
the tenant route 100. `{"data": {"items": [...], "nextCursor": "..."}}`; keep
going until `nextCursor` is `null`, passing the value back verbatim. A partly
read audit log looks exactly like a complete one, which is the failure the
cursor exists to prevent.

Rows written while you are paging sort above your cursor (newest first), so a
busy platform does not shift the boundaries underneath you.

A read with no live grant is `403 PLATFORM_AUTHORITY_REQUIRED`; a live grant
missing the capability is `403 PLATFORM_CAPABILITY_REQUIRED`. Neither says what
is missing — check your own grant with
`npm run grant:platform-admin -- --list`.

## Accounts the kinds migration left undecided (#263)

Every account is one kind: a player, a club account (exactly one club), or a
coach. The p37 migration decided almost every account from what it held — one
club role made it a club account and ended its player memberships — and left
two shapes alone on the owner's instruction: **club roles at two or more
clubs**, and **a coach role** (beside a club role, or on its own, since only
the coach flow may create a coach account). Those have `accountKind` NULL.

```bash
npm run report:undecided-accounts
npm run report:undecided-accounts -- --json
```

Read-only: the script opens a `READ ONLY` transaction. It derives the list from
memberships, not from the NULL, so it answers the same before the migration
(what would be undecided) and after (what is — every row should then say
`kind=NULL`).

An undecided account keeps the access it had and gains nothing: it cannot book,
accept an invitation or be made an owner until someone decides which account it
is. Settle one with the owner connection: expire or suspend the memberships that
should not stay, then set the kind. The database refuses a kind the remaining
ACTIVE memberships do not fit (`account_kind_membership_trg`), so a mistake is
an error rather than a mixed account.
