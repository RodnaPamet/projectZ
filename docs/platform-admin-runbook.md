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

| Capability       | Status                               |
| ---------------- | ------------------------------------ |
| `TENANT_READ`    | read any club's operational data     |
| `AUDIT_READ`     | read any club's audit log            |
| `USER_READ`      | read user records across clubs       |
| `TENANT_SUSPEND` | **declared, refused at the binding** |

`TENANT_SUSPEND` is refused because stepping up to a cross-club **write** should
require a second factor and there is none: `User.mfaSecret` is unencrypted and
nothing writes it. Granting it today buys nothing. If you need a cross-club write,
that is a decision to make deliberately, not a flag to flip during an incident.

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
