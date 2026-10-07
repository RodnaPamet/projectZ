# Onboarding a pilot club

There is no public club sign-up in the pilot (Q11). The owner of playerz, or
whoever runs ops, onboards each club with `scripts/onboard-club.ts` and a JSON
spec: the club, its owner's account, its venues, and their courts with grids,
durations, opening hours and prices. Run it on **staging first**, then on
production.

The script needs the database **owner** connection (`DIRECT_DATABASE_URL`).
`create-venue-org.ts` explains why this is a script and not a page in the app:
creating a club creates a tenant boundary, so nothing inside one can authorise
it.

## 1. Gather the club's data

Ask the club for the following. Every field is required unless marked
optional. The script deliberately has no defaults: a default price, or default
opening hours, would end up as the price or hours of every club.

**The club**

| What                                                                                                   | Spec field                       |
| ------------------------------------------------------------------------------------------------------ | -------------------------------- |
| Name as players should see it                                                                          | `club.name`                      |
| Short URL name, lower-case Latin with dashes (e.g. `sofia-padel`). Becomes `/clubs/{slug}`             | `club.slug`                      |
| Contact email for players                                                                              | `club.email`                     |
| Contact phone (optional)                                                                               | `club.phone`                     |
| **Owner's sign-in email**: the address of the Google (or Facebook) account they will sign in with      | `club.owner.email`               |
| Owner's name (optional)                                                                                | `club.owner.name`                |
| How many hours before the start a player may still cancel in the app (0–168)                           | `club.cancellationCutoffHours`   |
| How many upcoming online bookings one player may hold at once (1–50; the app's default is 3)           | `club.maxUpcomingOnlineBookings` |
| The club fee: % of the court price on played online bookings (0–30, two decimals; optional, default 0) | `club.feePercent`                |
| The first day the fee is charged, `YYYY-MM-DD` at the club (optional; default today + 2 months)        | `club.feeStartsOn`               |

The owner's email is the one thing worth checking twice. See
[§5](#5-how-the-owner-gets-in).

The fee (#372) is the pilot deal with this club. Bookings played before
`feeStartsOn` are on the club's statement at 0: the free period. Left out on a
new club, it is 0% from two months after today; left out on a re-run, the
club keeps what it has. A changed fee on an existing club needs `--update`,
like any other change, and only bookings played after the change are charged
at the new rate. The platform page `/platform/fees` sets the same two values
(with `CLUB_FEE_MANAGE` and a step-up).

**Each venue.** A club can have several.

| What                                                                                                                                 | Spec field                |
| ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------- |
| Name                                                                                                                                 | `name`                    |
| Short URL name, unique within the club. The public page becomes `/venues/{slug}` (or `{slug}-{club}` if another club already has it) | `slug`                    |
| Street address                                                                                                                       | `address`                 |
| City: `Sofia` or `София` (any city in `src/lib/geo/cities.ts`, so its Bulgarian name shows)                                          | `city`                    |
| Map pin. In Google Maps, right-click the entrance and click the coordinates to copy them                                             | `lat`, `lng`              |
| Timezone (optional, default `Europe/Sofia`)                                                                                          | `timezone`                |
| Its own email and phone, if different from the club's (optional)                                                                     | `email`, `phone`          |
| Its own cancellation cutoff, if different from the club's (optional)                                                                 | `cancellationCutoffHours` |
| Opening hours for **every** day, including closed days and any midday break                                                          | `hours`                   |

**Each court.**

| What                                                                                                                                                                                                                                | Spec field          |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| Name as the club calls it (`Корт 1`, `Padel 2`). The script finds the court again by this name, so keep it stable                                                                                                                   | `name`              |
| Sport: `PADEL`, `TENNIS`, `FOOTBALL5`, `FOOTBALL`, `BASKETBALL`, `VOLLEYBALL`, `BADMINTON`, `TABLE_TENNIS`, `PICKLEBALL`, `SQUASH`, `KARTING`, … (`SportType`)                                                                      | `sport`             |
| What the booking holds (optional): `COURT` unless said; `FIELD` for a pitch; `TRACK` for `KARTING`, which is always a track (left out, a karting court becomes one). A track is booked like a court and called a "писта" in the app | `resourceType`      |
| Surface: `CLAY`, `HARD`, `GRASS`, `ARTIFICIAL_GRASS`, `CARPET`, `WOOD`, `CONCRETE`                                                                                                                                                  | `surface`           |
| Indoor or outdoor                                                                                                                                                                                                                   | `indoor`            |
| Players on the court (padel 4, 5-a-side 10)                                                                                                                                                                                         | `capacity`          |
| Price **per hour** in **cents** (`3000` = €30.00)                                                                                                                                                                                   | `pricePerHourCents` |
| How often a booking may start: every 30 min, every hour… (the start grid)                                                                                                                                                           | `slotStepMinutes`   |
| Shortest booking. Every booking is a whole number of these                                                                                                                                                                          | `minBookingMinutes` |
| Longest booking                                                                                                                                                                                                                     | `maxBookingMinutes` |
| Its own hours, if they differ from the venue's (optional)                                                                                                                                                                           | `hours`             |

How the grid and durations combine: a padel court with `slotStepMinutes: 30`,
`minBookingMinutes: 90` and `maxBookingMinutes: 180` offers starts at 07:00,
07:30, 08:00, … and lengths of 90 or 180 minutes. Lengths are always whole
multiples of the minimum, so a club that wants 60, 90 and 120 minutes needs a
30-minute minimum. The script refuses combinations the app could not sell:
a maximum that is not a multiple of the minimum, a minimum that is not a
multiple of the step, or an hourly price that does not come to whole cents per
minimum-length booking.

**Squash and karting (P51).** A squash court is a court like any other. A
karting track is hired whole, by one group, in the track's own steps, like a
court: laps and arrive-and-drive sessions stay the club's own sales. Its
`resourceType` is `TRACK` (the default for `KARTING`, and refused for any other
sport), which is what makes the app call it a "писта" instead of a "корт". The
pilot clubs' courts, with the owner's values (name and price are the club's):

<!-- prettier-ignore -->
```jsonc
{
  "name": "Скуош",
  "sport": "SQUASH",                     // resourceType left out: COURT
  "surface": "WOOD",                     // sprung hardwood
  "indoor": true,
  "capacity": 2,
  "pricePerHourCents": 2400,             // a multiple of 4: whole cents per 45 minutes
  "slotStepMinutes": 15,
  "minBookingMinutes": 45,
  "maxBookingMinutes": 90
}
```

<!-- prettier-ignore -->
```jsonc
{
  "name": "Писта",
  "sport": "KARTING",
  "resourceType": "TRACK",               // optional: KARTING is always a TRACK
  "surface": "CONCRETE",                 // coated concrete
  "indoor": true,
  "capacity": 10,                        // drivers on the track at once
  "pricePerHourCents": 24000,            // the WHOLE track, per hour; a multiple of 4
  "slotStepMinutes": 15,
  "minBookingMinutes": 15,
  "maxBookingMinutes": 60
}
```

The squash court sells 45 or 90 minutes, not 60 or 75: lengths are whole
multiples of the minimum. Offering 45, 60, 75 and 90 needs a 15-minute minimum,
which also sells 15 and 30. The track sells 15, 30, 45 or 60 minutes.

Not part of onboarding, because the club does these itself in its admin at
`/t/{slug}/admin`: peak and off-peak pricing rules, holiday closures, staff,
and photos (#366). The club fee (#372) comes later.

## 2. Write the spec

[`example-club.json`](./example-club.json) has a club with two venues: an
indoor and an outdoor padel court on different hours, then a tennis court and
a 5-a-side pitch at a venue with a Monday lunch break. Copy it.

```jsonc
{
  "club": {
    "slug": "example-sports-club",
    "name": "Example Sports Club",
    "email": "hello@example.com",
    "phone": "+359 2 000 0000",                  // optional
    "owner": { "email": "owner@example.com", "name": "Example Owner" },
    "cancellationCutoffHours": 24,
    "maxUpcomingOnlineBookings": 3,
    "feePercent": "10",                          // optional, default 0
    "feeStartsOn": "2027-01-01"                  // optional, default today + 2 months
  },
  "venues": [
    {
      "slug": "example-padel-center",
      "name": "Example Padel Center",
      "address": "1 Example Street",
      "city": "Sofia",
      "lat": 42.6977, "lng": 23.3219,
      "timezone": "Europe/Sofia",                // optional, this is the default
      "hours": {
        "mon": ["07:00", "23:00"],               // open–close
        "tue": ["07:00", "23:00"],
        "wed": [["08:00", "12:00"], ["14:00", "22:00"]],   // with a break
        "thu": ["07:00", "23:00"],
        "fri": ["07:00", "23:00"],
        "sat": ["08:00", "22:00"],
        "sun": null                              // closed
      },
      "courts": [
        {
          "name": "Padel 1",
          "sport": "PADEL",
          "resourceType": "COURT",               // optional; FIELD for a pitch
          "surface": "ARTIFICIAL_GRASS",
          "indoor": true,
          "capacity": 4,
          "pricePerHourCents": 3000,
          "slotStepMinutes": 30,
          "minBookingMinutes": 90,
          "maxBookingMinutes": 180,
          "hours": { … }                         // optional, all seven days
        }
      ]
    }
  ]
}
```

(The real file is plain JSON. Comments are not allowed in it.)

Rules the script checks, with an error that names the field:

- All seven days are present in every `hours`, and a closed day is `null`.
  Times are `HH:MM`, 24-hour, `00:00`–`23:59`. A day cannot run past midnight.
- `city` must be a city the app can name in Bulgarian.
- `lat`/`lng` must be inside Bulgaria. That catches swapped coordinates.
  Still check the printed OpenStreetMap link to see the pin is on the right
  street.
- Unknown keys are errors, so a typo cannot be silently ignored.
- Venue slugs are unique within the spec, and court names are unique within
  their venue.
- `KARTING` is on a `TRACK` and nothing else is: a karting court with another
  `resourceType`, or a `TRACK` for another sport, is refused.

**What the script writes.** `basePriceCents` is the price of one minimum-length
booking (`pricePerHourCents × minBookingMinutes / 60`), because that is how the
booking engine prices: a 90-minute padel booking at €30/hour costs €45, and a
180-minute one costs €90. Each court also gets a base pricing rule, `Базова цена`
(priority 0, no conditions, ×1.00). It prices exactly the court's base price,
shows the club where its pricing starts, and loses to any rule the club adds.
It is a multiplier, not a fixed price, so when the club changes the court's
price in its admin, the new price takes effect.

## 3. Where and how to run it

Run it on the VM, from the **migrator** image, the same way
[deploy-gcp.md](../deploy-gcp.md) runs migrations. The runtime image has no
`npx` and no `tsx`. The env file supplies `DIRECT_DATABASE_URL`, and the spec
is mounted read-only.

Put the spec on the VM once:

```bash
sudo mkdir -p /opt/playerz/clubs
sudo cp ~/sofia-padel.json /opt/playerz/clubs/
```

The migrator image must include this script. The staging migrator is rebuilt
after every merge. The production migrator is promoted from staging at the
weekly release. To check:

```bash
sudo docker run --rm playerz-migrator:staging ls scripts/onboard-club.ts
```

### Staging first

```bash
# 1. Dry run: prints everything it would create or change, writes nothing.
sudo docker run --rm --network playerz_internal --env-file /opt/playerz/.env.staging \
  -v /opt/playerz/clubs:/clubs:ro -w /app \
  playerz-migrator:staging npx tsx scripts/onboard-club.ts --spec /clubs/sofia-padel.json --dry-run

# 2. Apply.
sudo docker run --rm --network playerz_internal --env-file /opt/playerz/.env.staging \
  -v /opt/playerz/clubs:/clubs:ro -w /app \
  playerz-migrator:staging npx tsx scripts/onboard-club.ts --spec /clubs/sofia-padel.json
```

### Verify on staging

The apply prints the club page, the admin, each venue's public address and a
map link. Then:

1. Open `https://<staging host>/clubs/{club.slug}`. The club shows every venue,
   and the city reads **София**.
2. Open each `https://<staging host>/venues/{publicSlug}`. Every court is
   listed. Pick a day and check the first and last start times, the step
   between them, the lengths offered and their prices against the spec.
   Check a closed day too.
3. Sign in as a test **player** (not the owner) and book a slot. The
   confirmation shows the price the spec implies. Then cancel the booking.
4. Open the map link to check the pin.

### Then production

The same commands with the production env file and image:

```bash
sudo docker run --rm --network playerz_internal --env-file /opt/playerz/.env \
  -v /opt/playerz/clubs:/clubs:ro -w /app \
  playerz-migrator:local npx tsx scripts/onboard-club.ts --spec /clubs/sofia-padel.json --dry-run

sudo docker run --rm --network playerz_internal --env-file /opt/playerz/.env \
  -v /opt/playerz/clubs:/clubs:ro -w /app \
  playerz-migrator:local npx tsx scripts/onboard-club.ts --spec /clubs/sofia-padel.json
```

Verify the same pages on `https://playerz.bg`, but do not book on
production. A booking there is a real reservation at a real club.

Locally, against a dev database: `npm run onboard:club -- --spec docs/onboarding/example-club.json --dry-run`.

## 4. Re-running, adding and changing

- **The same spec again** changes nothing ("everything in the spec already
  exists").
- **A venue or court added to the spec** is created on the next run. Nothing is
  ever deleted: a venue or court removed from the spec stays. To close a court,
  the club archives it in its admin.
- **A value that differs from the database** (a price, the hours, the booking
  cap…) is reported, and the run **writes nothing**, not even the new things in
  the same spec:

  ```
  ~ court example-park / Tennis 1
      price: €20.00/hour (basePriceCents 2000 per 60 min)  →  €22.00/hour (basePriceCents 2200 per 60 min)
  ✖ Nothing was written. …
  ```

  The difference may be the club's own edit in the app, so decide which side is
  right. If the spec is right, apply it with `--update --operator <your email>`.
  Every change is written to the club's audit log (`CLUB_ONBOARDING_UPDATED`,
  with the before and after values and your email). If the database is right,
  fix the spec.

- **Changed opening hours** take effect from today, in the venue's timezone.
  The old rows are kept as history (`effectiveTo`), not deleted. Bookings
  already made outside the new hours are not cancelled, so check the club's
  diary.
- **A different owner email** on an existing club adds that person as a second
  owner, with `--update`. The first owner stays until the club removes them.

Exit status: `0` when it applied, had nothing to do, or was a dry run; `1` when
the spec is invalid, the owner is refused, or a change needs `--update`.

## 5. How the owner gets in

The script creates the owner's account with **no password**, marked as a club
account and owner of this club. The account waits for them.

The first time they sign in **with Google** (or Facebook, once #361 ships)
using that **same email address**, sign-in matches the existing account by
email and they land in their club's admin. Nothing needs to be sent to them.
Tell them:

- "Sign in at playerz.bg with Google, using _owner@…_."
- The address must be exactly the email of the Google account (a Gmail
  address, or a Google Workspace address on a verified domain; Google sign-in
  refuses an unverified email). For Facebook, it is the email on the Facebook
  account, and a Facebook account with no email cannot be matched.

If they sign in with a different address, they get a new, separate account
that is **not** the club's. Fix it by re-running the spec with the right
address and `--update` (they become a second owner). The account under the
wrong address stays a separate account.

**Who can be an owner (#263): one account, one kind.** The script refuses, by
name, an address that:

- belongs to a **player** who already plays at a club. That person needs a
  separate address for the club account.
- belongs to a **coach** account.
- is already the club account of **another club**.
- is an account the #263 migration could not decide. Settle it first with
  `npm run report:undecided-accounts`.

An existing account that holds nothing yet becomes a club account. When the
owner is refused, nothing is written, not even the club.
