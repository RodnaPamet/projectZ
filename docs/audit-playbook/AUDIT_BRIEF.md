# Product audit by account kind: agent brief

A reusable brief for an agent that audits an app the way its users experience it, one account kind at a time.
Its first run on a production web app found 37 issues, including a blocker nobody had noticed: users had no
way to complete the app's core task. Fill in the `<…>` placeholders and hand the whole thing to a
background agent in an isolated worktree.

**The audit only. Don't fix anything or open PRs.** The owner prioritises the findings first.

---

You are in a git worktree of `<owner/repo>` (`<one-line product description>`). Your job is to walk the
product as every kind of user, record where it falls short, and file the gaps. Do not change product code.

## 1. Set up a realistic instance

- Never touch production. Run locally, in the closest thing to production the repo supports:
  - **Web:** a production build (e.g. `next build && next start`), not a dev server.
  - **iOS:** a Release-like build on the simulator, driven by XCUITest (the repo's screenshot harness, if it
    has one), against a local or staging backend.
- Use your own database, cache db and port, so you can't collide with other agents (`<db name>`, `<port>`).
  Copy env files from the main checkout and repoint them.
- Seed realistic data with the repo's seed or E2E helpers: several organisations/venues, past, upcoming and
  cancelled records, and **one account of every kind**: `<list the account kinds/roles, incl. signed-out,
brand-new/empty, half-onboarded, and every admin/staff/moderator role>`.
- Sign in the way the E2E suite does. If the real sign-in UI can't run locally (e.g. OAuth only), sign in
  programmatically and say in the report that the sign-in screen itself was not walked.

## 2. Walk every journey

For each account kind, at `<viewports: e.g. 393 px phone (primary) and 1280 px desktop; or iPhone SE + Pro Max>`,
in `<default locale>`, light theme (spot-check dark):

- where you land after sign-in, every reachable link, the header, tab bar, menus and account menu, and back
  navigation;
- the core tasks for that kind: `<e.g. discover → book → see/cancel → review; admin: manage X, invite staff;
moderator: reach the queue>`;
- how each kind gets from one area to another (public ↔ admin ↔ platform) and back.

Record:

- dead ends (no way onward or back);
- missing entry points;
- pages that exist but nothing links to;
- links to nothing (404s);
- broken layouts;
- untranslated or wrong-language text;
- missing empty and error states;
- anything that looks unfinished;
- real bugs you trip over.

Read code only to explain a finding, such as why a link is missing.

## 3. Evidence

- One screenshot per finding, plus one overview per account kind per viewport, with descriptive names
  (`<kind>-<viewport>-<what>.png`), saved under `<scratchpad>/audit/`. Never capture real secrets.

## 4. Cross-reference

- `gh issue list --state open --limit 200`: for each finding, note the open issue that already covers it.

## 5. Write the results

- `<scratchpad>/audit/findings.json`: an array of
  `{id, account_kind, viewport, area (navigation | missing-feature | bug | layout | copy | a11y | empty/error-state),
severity (blocker | major | minor), title, what_you_did, what_happened, expected, screenshot, existing_issue
(number or null), suggested_fix}`. Ids are short and grouped by kind (A01 for anonymous, P01 for player, …).
- `<scratchpad>/audit/journeys.md`: for each account kind, the navigation map as it actually is (what links
  where, which routes exist and which 404), so a redesign starts from facts.

## 6. File issues

- One issue for each **new blocker or major** finding that no open issue covers, with the measured repro.
- One epic, "Product audit <YYYY-MM>: navigation and gaps by account kind", listing **all** findings grouped by
  account kind, linking the new and existing issues.

## Constraints

- On a 16 GB machine, wrap heavy commands (builds, browser/simulator runs) in a shared lock, e.g.
  `lockf -k /tmp/<repo>-heavy.lock <command>`.
- Clean up afterwards: stop the servers or simulators you started (only yours, not a broad `pkill`), drop
  your DB and flush your cache db. Restore any role or config you changed.

## Report back

- the epic number;
- counts by severity and by account kind;
- the top 10 findings in priority order, with screenshot filenames;
- the paths of `findings.json` and `journeys.md`.
