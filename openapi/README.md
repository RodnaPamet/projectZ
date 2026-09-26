# The v1 API contract

`playerz-v1.json` is the source of truth the iOS client is generated from.
`NOTES.md` carries the behaviour a spec cannot express — timing, idempotency,
what to do on each error.

## Generating the Swift client

Apple's [swift-openapi-generator](https://github.com/apple/swift-openapi-generator)
runs as a SwiftPM build plugin, so the client regenerates on every build and
cannot drift from the spec silently.

In the iOS package, add to `Package.swift`:

```swift
dependencies: [
    .package(url: "https://github.com/apple/swift-openapi-generator", from: "1.0.0"),
    .package(url: "https://github.com/apple/swift-openapi-runtime", from: "1.0.0"),
    .package(url: "https://github.com/apple/swift-openapi-urlsession", from: "1.0.0"),
],
targets: [
    .target(
        name: "PlayerzAPI",
        dependencies: [
            .product(name: "OpenAPIRuntime", package: "swift-openapi-runtime"),
            .product(name: "OpenAPIURLSession", package: "swift-openapi-urlsession"),
        ],
        plugins: [.plugin(name: "OpenAPIGenerator", package: "swift-openapi-generator")]
    )
]
```

Copy `playerz-v1.json` to `Sources/PlayerzAPI/openapi.json` alongside an
`openapi-generator-config.yaml`:

```yaml
generate:
  - types
  - client
accessModifier: public
filter:
  tags:
    - Auth
    - Bookings
    - Devices
    - Payments
    - Payouts
    - Realtime
    - SSO
    - Tenant
    - Venues
```

## What the filter is for, and why it needs watching

Two tags are deliberately absent from that list.

**`Platform`** is cross-club administration — every club's records, reachable by
a person holding a row in `platform_admin_grant`. It is documented here because
an undocumented privileged API is worse than a documented one: the operators who
use it need to know what it records about them, and the next person adding a
platform route needs a shape to copy. It is not shipped in the app because the
phone has no business being able to call it. A grant is issued by CLI, held for
at most 90 days, and audited on every use; a generated Swift method sitting in
the binary invites all three to be worked around.

**`Internal`** is the Centrifugo subscribe proxy — the callback Centrifugo makes
to ask whether a connection may join a channel. Infrastructure calls it; a phone
never does. (The phone calls `POST /realtime/token`, which is tagged `Realtime`
and ships.)

That operation used to carry `["Realtime", "Internal"]`, which excluded nothing:
the filter is evaluated as a **union**, so one listed tag is enough to include an
operation however it is otherwise marked. It now carries `Internal` alone, and a
guardrail asserts no operation mixes an excluded tag with an included one.

**The filter is an include-list, not an exclude-list.** `swift-openapi-generator`
has no `excludeTags`, so a tag added to the spec and not added above is silently
missing from the client — which presents as "the SDK has no method for that
endpoint" long after the endpoint shipped.

`tests/guardrails/platform-route-discipline.test.ts` fails the build when the
two lists disagree: every tag in the spec must be either listed above or
deliberately excluded there, by name. Adding a feature area means editing both,
and forgetting is a red build rather than a missing method.

## Three things that will bite a client author

**Dates.** Every timestamp is RFC 3339 with **no fractional seconds**, because
Swift's default `.iso8601` strategy rejects the `.000` that `Date.toISOString()`
emits — and it fails at the _decoder_, so the error names the whole response
rather than the offending field. The generated client's default date strategy
matches what this API sends; do not override it to `.iso8601WithFractionalSeconds`.

**The envelope.** Success is `{"data": T}`, never a bare `T`. Paged reads are
`{"data": {"items": [...], "nextCursor": ...}}`. This is modelled explicitly in
the spec, so the generated types already carry it — but anyone hand-writing a
request against these paths needs to know.

**Idempotency.** `POST /t/{slug}/bookings` requires an `Idempotency-Key` header
and the server will reject the request without one. Generate a UUID per
user-initiated booking attempt and **reuse it across retries** of that same
attempt — that is the whole point. A fresh key on retry creates a second
booking and a second charge.

## Keeping it honest

`tests/guardrails/openapi-coverage.test.ts` fails the build when a v1 route
gains, loses or renames an operation without this file following — in both
directions, so a stale path that generates a client method calling a 404 is
caught too.

It does **not** verify that the schemas match the DTOs. That would require the
DTOs to be runtime values rather than TypeScript interfaces. Saying so plainly
is better than implying a guarantee that is not there.
