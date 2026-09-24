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
```

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
