# What playerz.bg is built on

## Ported from `inflect-compliance`

The UI platform and the infrastructure layer, not the domain.

| Ported                                                                                                                     | Why it was safe to port                                                                                       |
| -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `src/components/ui/**`, `layout/`, `theme/` (484 files)                                                                    | Genuinely domain-neutral. A Button, a DataTable and a CalendarMonth do not know what a compliance control is. |
| `src/styles/tokens.css`                                                                                                    | The semantic token _architecture_. Every hue carrying METRO / PwC brand identity was replaced.                |
| `lib/errors`, `lib/observability`, `lib/security` (headers, csp, cors, sanitize, encryption, rate-limit), `lib/pagination` | Infrastructure.                                                                                               |
| `scripts/detect-secrets.sh`                                                                                                | Byte-identical.                                                                                               |

## Deliberately NOT ported

Everything that encodes a _compliance product_:

- `AppShell` / `SidebarNav` / `TopChrome` — nav items are `/controls`,
  `/risks`, `/evidence`, `/policies`, `/vendors`. Porting them would have
  given a court-booking app a "Risks" tab. playerz has its own `AppNav`, and
  a rendered test fails if compliance vocabulary ever reappears in it.
- `lib/permissions.ts` — its `PermissionSet` is controls/evidence/vendors.
- `AleHistogram`, `LossExceedanceCurve` (risk-quant charts), `GanttChart`.
- `Chart3D` / `BarField3D` — need three.js, which is not even a dependency of
  the port source. Dead code there too.

## A bug we found in the port source

`sanitizePlainText` decoded `&amp;` **first**, which made it a
double-unescape: `&amp;lt;script&amp;gt;` becomes `&lt;script&gt;` on the
first pass and a live `<script>` on the second. **The sanitiser resurrects the
tag it just stripped**, and per its own contract the result is written to
surfaces that decode entities.

Fixed here (decode `&amp;` last, pinned by a test). inflect-compliance has the
same fix: its `src/lib/security/sanitize.ts` decodes `&amp;` last (checked at
its origin/main on 2026-09-30, #279).

## Third-party dependencies that carry real risk

| Package              | What it guards                                                   | If it breaks                                                                                                                    |
| -------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `stripe`             | Webhook signature verification                                   | A forged `payment_intent.succeeded` marks any booking paid. The signature is the _only_ authentication — Stripe has no session. |
| `bcryptjs`           | Password hashing (12 rounds)                                     | Also the timing-equalisation for `dummyVerify` — see P07.                                                                       |
| `@prisma/adapter-pg` | Every query, and the SQLSTATE surfaced on a constraint violation | P09's `slot_taken` mapping depends on reading `23P01` out of a Prisma error whose shape varies by violation kind.               |
| `sanitize-html`      | Chat, bios, booking notes                                        | The XSS surface.                                                                                                                |
| `date-fns-tz`        | Venue-local opening hours → absolute UTC                         | Get this wrong and every slot shifts by an hour at the DST changeover.                                                          |

## The database is doing the load-bearing work

Three guarantees live in Postgres, not in TypeScript, and that is deliberate:

1. **RLS** — a query that forgets its tenant filter returns zero rows, not
   another tenant's data.
2. **`booking_no_overlap` (EXCLUDE … USING gist)** — the _only_ thing that
   makes double-booking impossible under concurrency. An app-layer check
   cannot do it.
3. **`booking_span_valid` (CHECK)** — a booking cannot end before it starts.

Delete every line of application code and those three still hold.
