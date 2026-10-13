# P11 — player pages & the guardrail suite

## The structural tenant-isolation ratchet is the important one

RLS is the guarantee, and it **fails closed** — a query that forgets its
tenant filter returns **zero rows**, not another tenant's data. That is the
right failure mode, and it is precisely what makes this ratchet necessary.

Because _"returns zero rows"_ is **invisible**. The endpoint 200s with an
empty list. No exception, no log line, no failing test. The page tells a
customer with twelve bookings that they have none, and you find out from a
support ticket.

Worse: the day that repository is called from a background job or an admin
path running as `app_superuser` — which **bypasses RLS** — the missing filter
stops being a silent empty list and becomes a **real cross-tenant leak**.

So every Prisma call in the repository/usecase layer must carry an explicit
`tenantId`, _even though RLS would add it anyway_. Belt and braces, enforced
by the build.

**Negative-controlled:** a repository with `db.booking.findMany({ where: {
status: 'CONFIRMED' } })` and no tenantId fails immediately.

Two things the scanner had to learn, and both are worth recording:

- **Skip comments.** The doc comment in `booking.ts` shows the _wrong_
  pattern deliberately, so nobody writes it. The first version of the ratchet
  flagged its own documentation — and a guardrail that cries wolf on its own
  explanation teaches people to ignore it.
- **Accept the justification ABOVE the call**, not just inline. That is where
  a reader naturally looks for it.

The one legitimate cross-tenant query — public venue search — carries an
explicit `guardrail-allow: cross-tenant` with its reason.

## `any` ratchet: baseline zero

One `any` in a security path is worth more than a hundred elsewhere. An `any`
on a permission check, a tenant id, or a JWT claim **silently disables every
type guarantee downstream of it** — and the code still compiles, still passes
review, and still looks exactly like the safe version.

Baseline is 0, on `lib/auth`, `lib/security`, `app-layer/policies` and
`proxy.ts`. A number that can only fall.

## Logging hygiene

`console.log` in a request path is not a style problem:

- unstructured, so it cannot be queried when you actually need it;
- **unredacted**, so it prints the whole object — the password field, the
  Stripe secret, the player's email — into a log aggregator that far more
  people can read than can read the database;
- and it never gets removed, because it never fails anything.

The most common production data leak is not an attacker. It is a
`console.log(user)` somebody added while debugging.

`scripts/` and the job runners are exempt: those print to a terminal a human
is watching.

## The pages go through the repository, not Prisma

`venues/page.tsx` is a server component that calls `listVenues()` rather than
reaching for the Prisma client directly.

That is not layering for its own sake. A page that queried Prisma directly
would slip past **both** the query-shape ratchet (unbounded `findMany`) and
the tenant-isolation ratchet — the two guardrails most likely to catch the
bug that takes the site down.
