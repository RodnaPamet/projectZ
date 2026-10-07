# ui-sync: the UI playerz shares with inflect-compliance

playerz's UI primitives are copies of files in
[RodnaPamet/inflect-compliance](https://github.com/RodnaPamet/inflect-compliance), kept at the same
paths: `src/components/{ui,layout,theme,nav,filters}` and the few `src/lib` modules they need
(`cn`, `theme-constants`, the keyboard-shortcut registry). The first copy was playerz 58a6ebd
(2026-07-11), from inflect `1520b8b87`. Nothing recorded which files were copies, so fixes landed
in place. Measured on 44048af against inflect `8d2feb4e3`, with both sides normalised: of the 480
component files the repos share, 430 were identical, 21 had changed only in inflect, 16 only in
playerz, 10 on both sides, and 3 at the port itself.

This directory records which files are copies and locks them, so that a change goes to inflect
first and comes back unchanged.

inflect is moving that UI into a workspace package, `@inflect/ui` at `packages/ui` (inflect
#3046). playerz keeps its copies where they are. See
[inflect's `@inflect/ui` package](#inflects-inflectui-package).

## The rule: upstream first

A vendored file equals `prettier(inflect@sha)`, formatted with this repo's `.prettierrc` (single
quotes, Tailwind class order), byte for byte. To change one:

1. **Change it in inflect.** Work in an inflect worktree, following inflect's own conventions.
   Before opening the PR, run playerz's rules over the files you touched:

   ```sh
   node <playerz checkout>/scripts/ui-sync/check-portable.mjs --root . <changed files>
   ```

   Fix everything it reports, then open the PR and merge it green.

2. **Copy it back.**

   ```sh
   git -C <inflect checkout> fetch origin
   node scripts/ui-sync/copy.mjs --ref <merged sha> <inflect paths or directories>
   ```

3. **Commit the files together with their manifest rows.** `copy.mjs` names any import the copied
   files need that playerz does not have yet: copy those too, or add the package.

`tests/guardrails/ui-sync-manifest.test.ts` fails on any other edit to a vendored file. It also
fails when any vendored file has a `check-portable` finding.

**The escape hatch** is a `local-diff` row. It is for a fix that cannot wait for inflect, and it
must carry a `reason` and an `upstream` link to the inflect PR or issue that will remove it. Every
local-diff is a fork until then, so the list should only ever shrink.

The pre-commit hook runs `prettier --write` (a no-op on a copied file) and `eslint --fix`. If
eslint rewrites a copied file, the guardrail fails: make that fix upstream as well.

## The manifest

`docs/ui-sync/manifest/<dir>.json` has one file per directory, so parallel PRs that vendor
different parts of the tree write different files: `ui`, `ui-table`, `ui-hooks`, `ui-icons`,
`layout`, `theme`, `nav`, `filters` and `lib`. Each has one row per playerz file whose path also
exists in inflect:

| Field         | Meaning                                                                                                                                     |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `path`        | The file in playerz.                                                                                                                        |
| `inflectPath` | The file in inflect: `path`, or `packages/ui/src/<p>` for `src/<p>` once inflect has moved it into `@inflect/ui`.                           |
| `baseSha`     | The inflect commit the file was last synced from, which `status.mjs` uses as the merge base. It is `1520b8b87` until the file is re-synced. |
| `sha`         | The inflect commit a `vendored` file was copied from. It is `null` while the row is `pending`.                                              |
| `status`      | `pending` (from the 2026-07 port, not re-synced yet), `vendored` (written by `copy.mjs`) or `local-diff`.                                   |
| `sha256`      | The digest of the committed bytes. The guardrail checks it for `pending` and `vendored` rows.                                               |
| `reason`      | Required on `local-diff` rows: why the file differs from inflect.                                                                           |
| `upstream`    | Required on `local-diff` rows: `https://github.com/RodnaPamet/inflect-compliance/pull/<n>` (or `/issues/<n>`).                              |

Only scripts write rows: `copy.mjs` on every copy, and `paths.mjs --add-pending` for files that
predate it. playerz's own files have no row. Those are the token values (`tokens.css`,
`tailwind.config.ts`, `globals.css`), `messages/*.json`, `mobile/*`, `chess/*`, the playerz layout
files (`SiteHeader`, `SignOutButton`, `nav-items`, …) and every route. A playerz-owned file must
not sit at a path that inflect uses.

When you delete a vendored file, move its row to `docs/ui-sync/available.json` with its
`inflectPath` and SHAs, so the file can be copied back later. The first deletion creates that
file as a JSON array; until then it does not exist.

`docs/ui-sync/inflect-paths.txt` lists every inflect path under the synced directories at one
recorded inflect commit, plus the vendored `src/lib` modules, in both of inflect's layouts
(`src/<p>` and `packages/ui/src/<p>`). CI has no inflect clone, so the guardrail reads this list to
check that every playerz file at one of those paths has a row; it looks for `packages/ui/src/<p>`
at `src/<p>`. A file copied from inflect by hand, outside `copy.mjs`, would otherwise pass as
playerz's own. Regenerate the list with `node scripts/ui-sync/paths.mjs --ref <sha> --write`.

## inflect's `@inflect/ui` package

inflect #3046 is moving the shared UI out of `src/` into the npm workspace package `@inflect/ui`
at `packages/ui`, one directory per PR. The package mirrors `src/`: `src/lib/cn.ts` became
`packages/ui/src/lib/cn.ts` (step 2a), and the icons (2b) and 21 of the 24 `ui/hooks` (3a)
followed. `table/`, the flat primitives, `layout/` and `src/lib/hooks` are next. Its
`package.json` exports `@inflect/ui/<p>` as `packages/ui/src/<p>`.

playerz keeps every copy at `src/<p>`, and a byte-identical copy still resolves there:

- A file that moved imports its neighbours by relative path (`../../../lib/cn`). The same relative
  path from `src/<p>` reaches playerz's copy, because the package has the same layout as `src/`.
- A file still in inflect's `src/` imports a moved one as `@inflect/ui/<p>`. `tsconfig.json`
  `paths` (which Next and Turbopack read) and `jest.config.mjs` map `@inflect/ui/*` onto `src/*`,
  as they map `@/*`. So do the hand-written resolvers in `scripts/ui-sync` and the guardrails, all
  through `aliasTarget` in `scripts/ui-sync/inflect-package.mjs`. The bare `@inflect/ui` (the
  package's index) is not mapped, because playerz vendors no copy of it.

The tools look for a row's file in both layouts, the package first, at every commit they read.
A move is therefore never GONE, whether or not the row has caught up:

- `status.mjs` compares the file where inflect has it, and lists the rows whose file moved since
  their `inflectPath` was written (`moved` in `--json`, **Moved in inflect** in the issue).
- `copy.mjs` takes either path and records where inflect has the file at `--ref`.
- `paths.mjs --ref <sha> --repoint` points every row whose file moved, in the manifest and in
  `available.json`, at its new path. Nothing else in the row changes: `baseSha` and `sha` still
  name the commits the file was synced from, and the tools read those at its old path.

After an inflect step moves files, run `paths.mjs --ref <sha> --repoint --write`, then
`status.mjs --ref <sha>`, and copy the TAKE rows the move made: a file left in `src/` that now
imports `@inflect/ui/<p>` instead of `@/<p>` is a one-line TAKE. If inflect ever keeps one file
in both layouts at once, `status.mjs` notes it, because playerz can hold only one.

## The tools

All of them are Node ESM with no dependencies beyond the repo's own (prettier and its Tailwind
plugin, and TypeScript for `check-portable`). They read inflect from `$INFLECT_DIR`, or else from
`inflect-compliance` next to the main playerz checkout. That is `/Users/user/git/inflect-compliance`
on the owner's machine, and the default works from a worktree too.

- **`status.mjs [--ref <rev>] [path prefixes]`** compares each row three ways: inflect at the
  row's `baseSha`, inflect at `--ref` (default `origin/main`), and playerz. Each row gets one
  verdict:
  - **IDENTICAL**: nothing to do.
  - **TAKE**: only inflect changed, so copy it.
  - **KEEP**: only playerz changed, so upstream the change.
  - **MERGE**: both changed.
  - **GONE**: inflect removed the file, in both layouts.

  It also lists the imports that playerz cannot resolve for TAKE and MERGE rows, and the rows
  whose file inflect moved. `--json` and `--markdown` write the full result to a file.
  `--playerz <rev>` reads playerz from a commit, and `--port <rev>` marks the edits made at the
  original port.

- **`copy.mjs --ref <rev> <paths or directories>`** writes the normalised inflect file at its
  playerz path (`src/<p>` for `packages/ui/src/<p>`) and sets its row to `vendored` at that
  commit. A path may name either layout, and a directory is read in both. A directory copies the
  code files under it, never inflect's `GUIDE.md` docs.
- **`check-portable.mjs --root <dir> <files>`** runs playerz's guardrail rules over files in
  another checkout. It checks for raw palette classes, English copy (including `?? 'fallback'`
  and default props), compliance vocabulary and the Inflect, PwC, METRO and Dub brands, and
  hand-rolled menus (`fixed inset-0` outside modal, sheet and popover). It also checks for
  `<select`, inline or infinite animation, and `text-brand-NNN` or `text-` with an arbitrary
  `var(--brand-<name>)` value. It exits 1 on any finding.

  Its `a11y-copy` rule reads the text a screen reader speaks: `aria-label` and the other ARIA
  text attributes, their camelCase props (`ariaLabel`, `closeAriaLabel`), `alt`, and `title` on
  an HTML element or an interactive component, in JSX, object literals, parameter defaults and
  `setAttribute`. It flags any literal with words in it, including a single lowercase word and
  the words around a template's `${…}`. The vendored `LocaleSwitcher` passed the older rules with
  `ariaLabel="Language"` because they read only the kebab-case attribute (inflect #3201).

  It also runs over the whole manifest. `--manifest vendored` checks every `vendored` row's file
  and exits 1 on any finding. The guardrail runs the same scan, so a finding in any vendored
  file fails CI, not only in the files a PR copies. `--manifest pending [--ref <inflect rev>]`
  lists the findings in `pending` rows and always exits 0. Those files are inflect's to fix
  (#3047/#3048), so check this list before a batch copies them. Without `--ref` it reads the
  playerz copies. With `--ref` it reads each row's file where inflect keeps it at that commit,
  which is what a copy would bring in, and says how many rows it could not find there.

  An overlay primitive keeps its exemption under `packages/ui/src/`, so the upstream check works
  on the file where inflect keeps it.

- **`reachability.mjs [--roots <glob>] [--scope <prefix>]`** builds a symbol-level, barrel-aware
  import graph rooted at `src/app/**`, `src/*.ts` and `scripts/**`. It prints JSON listing the
  unreachable files under the scope (default `src/components/`), with counts per directory. It
  cannot see a file that is referenced only by a string, such as next.config's next-intl request
  path or a guardrail's `readFileSync`, so check such a file before deleting it.
- **`paths.mjs [--ref <rev>] [--write] [--add-pending] [--repoint]`** reports the playerz files
  at inflect paths that have no row, and rewrites `inflect-paths.txt`. `--repoint` points the rows
  of files inflect moved at their new paths.

To reproduce the 2026-09-27 measurement:

```sh
node scripts/ui-sync/status.mjs --ref 8d2feb4e3 --playerz 44048af --port 58a6ebd src/components
# IDENTICAL 430 · TAKE 21 · KEEP 19 · MERGE 10 · GONE 0
# port-time (58a6ebda7): … KEEP since the port 16, KEEP port-time 3
```

## Weekly drift

`.github/workflows/ui-drift.yml` runs `status.mjs` against inflect's `main` every Monday. It keeps
one issue, **UI drift vs inflect `<sha>`**, up to date with the TAKE, MERGE and GONE rows (KEEP is
listed collapsed). It closes the issue when none are left and reopens it when drift comes back.
Drift does not fail anything: the workflow goes red only when it cannot run. A row whose file
inflect moved into `packages/ui` is listed under **Moved in inflect** (collapsed). A move is not
drift, so it neither opens nor keeps open the issue.

## Visual baselines (Linux only)

The `@visual` baselines are committed as `*-chromium-linux.png`, because CI compares on Ubuntu.
On a Mac the same specs write `-darwin` PNGs that nothing compares against. `.gitignore` keeps
them out, and they must never be committed. When a change moves pixels on purpose, regenerate the
Linux PNGs on GitHub:

```sh
gh workflow run visual-baselines.yml --ref <your branch>
gh run watch                                   # pick the run it started
gh run download <run-id> -n visual-baselines-<sha> -D .
git status --short -- tests/e2e                # only *-chromium-linux.png; open each one
git add -- ':(glob)tests/**/*-chromium-linux.png'
git commit                                     # your own push runs CI as usual
```

The workflow checks out the branch you dispatched it on and runs `npx playwright test --project=chromium --grep @visual
--update-snapshots` on the same PostGIS, Redis and seed stack as the E2E job. It uploads only the
`-chromium-linux.png` files that changed, with their repo paths, as the artifact
`visual-baselines-<full sha>`. The run summary prints the exact download command. When no PNG
changed, it uploads nothing and says so.

It commits nothing and holds no write token, for two reasons. A push made with `GITHUB_TOKEN`
starts no workflow run, so a commit from the job would leave your PR without CI. And a new
baseline should be looked at before it becomes the reference. The branch is `--ref`, not an
input: the dispatch then runs that branch's own copy of the workflow, and the npm cache it writes
stays scoped to that branch instead of `main`'s. The workflow has to exist on `main` before GitHub
offers it for dispatch at all, and it can name only a branch or tag of this repo.
