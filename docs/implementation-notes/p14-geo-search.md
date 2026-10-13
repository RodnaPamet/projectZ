# P14 — geo & search

## `geography`, not `geometry`

`geography(Point, 4326)` does **spherical** math on the WGS-84 ellipsoid, so
`ST_DWithin` takes **metres** and the answer is a real distance.

`geometry` on lat/lng does **planar** math on **degrees**. At Sofia's latitude
a degree of longitude is ~74km and a degree of latitude ~111km — so a "10 unit"
radius is an ellipse, not a circle, and every distance is wrong in a way that
looks entirely plausible until somebody drives to a venue that was supposedly
5km away.

Verified against real coordinates: Sofia → Plovdiv computes as **132.8 km**
(the true road-free distance is ~133 km). A 5km search from Sofia returns Sofia
and not Plovdiv — which a `geometry` implementation would get wrong, because
Plovdiv is only 1.4 _degrees_ away.

## The trigger, not the write path

`geog` is kept in sync by a Postgres trigger on `INSERT OR UPDATE OF lat, lng`.

The alternative is remembering to update `geog` in every write path. That works
until the first one that forgets — and a venue with a stale `geog` does not
error. It just quietly stops appearing in "near me", and nobody notices except
the venue owner, losing bookings to a search they never show up in.

A test moves a venue from Sofia to Varna and asserts it _leaves_ the Sofia
results and _enters_ the Varna ones.

## Swapping the Postgres image changes the collation version

Moving from `postgres:16` to `postgis/postgis:16-3.4` changes the glibc the
server runs against:

```
WARNING: database has a collation version mismatch
DETAIL:  created using collation version 2.41, but the OS provides 2.31
```

**This is not cosmetic.** Text indexes are ordered by collation, so a mismatched
one can return **wrong results** for range scans on text columns — silently.

After the image swap you must `REINDEX DATABASE` and
`ALTER DATABASE … REFRESH COLLATION VERSION`, **before serving traffic**. The
migration documents it; it bit us here first.

## The radius cap is not a nicety

`/api/venues/near` is public and unauthenticated. Without a cap, one GET asking
for a 20,000km radius scans the whole table and sorts it. The ceiling lives in
`nearVenues`, not in the route — so it holds for every caller, including a job
or an admin page that forgets to clamp.

Coordinates are validated _before_ they reach SQL. The query uses `Prisma.sql`
with **bound parameters**, so injection is impossible regardless — but a caller
passing `lat=999` gets a 400 naming the problem instead of a PostGIS error
about a point outside the ellipsoid.

`ST_DWithin` is the indexed predicate (GiST). Filtering on
`ST_Distance(...) < r` instead would compute the distance for **every venue in
the table** before discarding almost all of them.

## Meilisearch is never exposed to the browser

The "obvious" optimisation — give the client a search-only key and let it query
Meilisearch directly — **leaks the whole index**. Our documents carry
`tenantId`, so a browser holding a search key could enumerate every venue,
coach and session of _every tenant_. RLS would be perfectly intact and the data
would be public anyway.

Everything goes through `/api/search`, where the filter is applied server-side.

## The index is a cache; Postgres is the truth

Every sync call is best-effort. If Meilisearch is down, unreachable, or its
volume was deleted, the product degrades to "search is limited" — never to
"your booking failed".

An integration test points the client at a **dead Meilisearch** and asserts the
venue write still succeeds and `syncVenue` resolves rather than throwing. A
write rolled back because a _search server_ was unavailable would be an absurd
way to lose data.

`reindexAll` exists because **a cache you cannot rebuild is not a cache, it is
a liability**.

## The sync ratchet caught a real gap on its first run

I declared a `coaches` index and never wrote its sync. The ratchet failed
immediately.

That is precisely the bug it exists for, and it is the quietest one in this
area: search still _works_, it just returns **stale data forever**. A venue
renames itself and search shows the old name; a session fills and search still
offers it; a venue closes and players keep clicking through to a 404. Nothing
throws, nothing fails — the only signal is a slow trickle of "search is wrong"
complaints nobody can reproduce, because the _database_ is correct.

## Typo tolerance is the whole point

Tested against a **real Meilisearch**, not a mock: `"padle"` finds the padel
venue. A mocked search test proves the mapper compiles; it cannot prove that,
and typo tolerance is the entire reason to run a search engine instead of an
`ILIKE`.

> **2026-10-13 (#258):** the Meilisearch side of this was removed before it was ever deployed. `/api/search`, `src/lib/search/*` and `scripts/search-setup.ts` are gone; /venues and player search query Postgres. #482 tracks bringing a search engine back if volume calls for it.
