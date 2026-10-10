# P04 — Prisma foundation & RLS

## The hybrid tenancy shape

A **player is global**. One `User`, one identity, one Glicko-2 rating,
playing at many venues. A **staff relationship is per-tenant** —
`TenantMembership` carries the `tenantId`, so the same human can be a COACH
at one club and a PLAYER at another.

Consequence: `User` and `PlayerProfile` have **no RLS**. They are global by
design. If they were tenant-scoped, joining a second club would require a
second account and a player's rating would fork.

That is a dangerous-looking exception, so it is not left to reviewer
attention: `tests/guardrails/rls-coverage.test.ts` parses the schema, finds
every model with a `tenantId`, and fails unless it has ENABLE + FORCE row
level security, a `tenant_isolation` policy and a `superuser_bypass` policy.
`User` and `PlayerProfile` sit on an explicit two-item allowlist, and a
further test asserts the allowlist contains _only_ those two — widening it
requires editing a test, which forces the conversation.

**Verified by negative control:** adding a `LeakyTable` model with a
`tenantId` and no policy immediately fails the ratchet.

## Deviation: cuid, not uuid

P04's prompt writes the policies as
`current_setting('app.tenant_id', true)::uuid`.

Our ids are **cuid** (`String @default(cuid())`) — that is what P03 shipped
and what `main` already carries. Casting a cuid to `uuid` throws on _every
query_, so the policies compare text to text.

The `::uuid` cast would have doubled as an input validator. That job is done
explicitly instead:

- `set_config('app.tenant_id', $1, true)` is **parameterised** — the tenant
  id is never concatenated into SQL, so injection is impossible regardless.
- `runInTenantContext()` validates the id against a cuid pattern _before_
  touching the database, so a caller passing a slug, an email, or
  `'; DROP TABLE venue_org; --` gets a loud `InvalidTenantIdError` rather
  than a session silently bound to a nonsense tenant that matches no rows.

A unit test asserts that malformed input raises **before a single statement
is issued**.

## The UserSession policy is tenant-only (P58)

`UserSession.tenantId` is nullable: a session exists between sign-in and
tenant selection, and in practice every session row is NULL-tenant (both
sign-in paths pass `tenantId: null`).

P04 shipped an asymmetric policy: `USING ("tenantId" IS NULL OR …)` so a
pre-tenant session was readable, and a tenant-only `WITH CHECK`. The claim
that this meant `app_user` "can never re-parent an existing session" held for
INSERT only. `USING` also governs UPDATE and DELETE, so every `app_user`
session, bound to any club or none, could read every session row (token
hashes included) and delete it (#488).

No `app_user` path ever needed the NULL branch: sign-in, `checkSession`,
refresh, sign-out, the MFA step-up, the data export and account deletion all
run on `runAsSuperuser`. P58 therefore keys the policy on the tenant alone:

```sql
USING      ("tenantId" = current_setting('app.tenant_id', true))
WITH CHECK ("tenantId" = current_setting('app.tenant_id', true))
```

A pre-tenant session is minted and read _outside_ any tenant context, on the
superuser path. `tests/integration/null-tenant-rls.test.ts` proves both
halves: the real sign-in, refresh and sign-out routes still work, and no
`app_user` binding reads, deletes or re-tenants a NULL-tenant session.

## Why FORCE, not just ENABLE

`ENABLE ROW LEVEL SECURITY` does not apply the policy to the table's
**owner** — and migrations run as the owner. Without `FORCE`, the policy
would be untested in precisely the session that matters most.

## Why `runInTenantContext` has no RESET

`SET LOCAL` and `set_config(..., true)` are transaction-scoped: both are
released when the transaction ends, on commit _or_ rollback. A leaked
binding is impossible by construction. An explicit RESET in a `finally`
would be dead code that implies otherwise — and a unit test asserts no RESET
is ever issued, so nobody adds one back "just to be safe".

## Why AsyncLocalStorage for the tenant context

A module-level "current tenant" variable is shared across concurrent
requests in the same Node process. Under load, request A would read request
B's tenant — a cross-tenant leak with no stack trace and no failing test.
`AsyncLocalStorage` scopes it to the async call tree.
