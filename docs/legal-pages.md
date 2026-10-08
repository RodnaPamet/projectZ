# The legal pages (#370)

playerz.bg has three legal texts: the privacy policy, the terms of use and the
cookie policy, each in Bulgarian and English. **The owner or a lawyer writes
them. Nobody else does**, not even as a placeholder: a draft that reads like a
policy is a policy somebody can quote.

| Page       | Text file                          |
| ---------- | ---------------------------------- |
| `/privacy` | `content/legal/{bg,en}/privacy.md` |
| `/terms`   | `content/legal/{bg,en}/terms.md`   |
| `/cookies` | `content/legal/{bg,en}/cookies.md` |

## Until a text exists

A page whose text is missing in the visitor's language **answers 404, and
nothing links to it**:

- the footer shows only the texts that exist;
- the landing page's contact form says how the details are used, without the
  privacy link;
- the first-sign-in screen (`/start/kind`) shows its "Продължавайки, приемате
  Общите условия и Политиката за поверителност" line only when both texts exist;
- `/me/profile → Поверителност` lists only the texts that exist;
- the cookie notice links to `/cookies` only once that text exists.

An empty file counts as missing. Each language is judged on its own: with only
`bg/privacy.md` in place, `/privacy` works in Bulgarian, answers 404 in English,
and the English pages do not link to it.

`/delete-account`, how to delete an account (#445), is not a legal text. It is
product help, it is always there, and the footer always links to it.

## Adding or changing a text

1. Convert the DOCX to Markdown with [pandoc](https://pandoc.org):

   ```bash
   pandoc -f docx -t gfm-raw_html --wrap=none "Политика за поверителност.docx" \
     -o content/legal/bg/privacy.md
   ```

   `gfm-raw_html` writes plain Markdown and no HTML. The page ignores raw HTML,
   so a document full of it would show up with pieces missing.

2. Read the result once against the DOCX:
   - **The first line is the title**, as one `#` heading: `# Политика за поверителност`.
     The page uses it as its heading and its browser title. Without one, the
     page uses its own name.
   - Sections are `##`, sub-sections `###`.
   - Numbered and bulleted lists, **bold**, _italic_, links and simple tables
     come through as they are. Links may point at `https://`, `mailto:`,
     `tel:`, a path on the site (`/cookies`) or a heading (`#section`). Any
     other link is shown as plain text.
   - Images are dropped. A legal text should not need one.

3. Do the same for the English file, at the same name under `content/legal/en/`.

4. Commit and deploy. The texts are read from disk on each request, and the
   image carries `content/` (see the Dockerfile), so the next deploy publishes
   them. No code changes.

To check locally, run the dev server and open `/privacy` in both languages.
The language is the footer's switch, or the `NEXT_LOCALE` cookie.

## Facebook (#445)

The Meta app needs two URLs before it can go Live (docs/oauth-setup.md):

- **Privacy Policy URL**: `https://playerz.bg/privacy`, once `privacy.md` exists.
- **Data Deletion Instructions URL**: `https://playerz.bg/delete-account`, which
  exists already.

## The cookie notice

Visitors who are not signed in see a small notice: playerz.bg uses only
essential cookies. There is nothing to accept or reject, because nothing needs
consent. Hiding the notice is remembered in that browser's localStorage. It
links to `/cookies` once `cookies.md` exists.

"Essential only" rests on this audit (#370, 2026-10-08). A new cookie, storage
key or third-party script means doing it again before it ships, and updating
the cookie policy's text with the owner.

| Name                                                                                 | Where        | Written when                                                                 | For                                             |
| ------------------------------------------------------------------------------------ | ------------ | ---------------------------------------------------------------------------- | ----------------------------------------------- |
| `next-auth.session-token` (`__Secure-` in production; chunked `.0`, `.1` when large) | cookie       | signing in                                                                   | staying signed in                               |
| `next-auth.csrf-token`, `next-auth.callback-url`                                     | cookie       | opening sign-in                                                              | the sign-in's security                          |
| `next-auth.pkce.code_verifier`, `next-auth.state`                                    | cookie       | during a Google or Facebook sign-in, for minutes                             | the sign-in's security                          |
| `NEXT_LOCALE`                                                                        | cookie       | using the language switch, or signing in to an account with a saved language | the language the person chose                   |
| `playerz_theme`                                                                      | cookie       | picking a theme                                                              | the theme the person chose, drawn by the server |
| `playerz:theme`                                                                      | localStorage | picking a theme                                                              | the same                                        |
| `playerz:sidebar-collapsed`                                                          | localStorage | collapsing the sidebar                                                       | the layout the person chose                     |
| `playerz:cookie-notice`                                                              | localStorage | hiding this notice                                                           | not showing it again                            |

Nothing is kept in sessionStorage, IndexedDB or Cache Storage; the service
worker is never registered. Inter is self-hosted, Sentry runs on the server,
and there are no analytics or ads. The only other origins a page loads from
are images: profile pictures from Google and Facebook on signed-in pages
(#458 is to keep our own copy) and venue photos from Cloud Storage. They set no
cookies, though they see the viewer's IP address.

A theme is written only when the person picks one: the vendored ThemeProvider
(inflect #3270) writes in `setTheme` and `toggle`, never on a first visit or
from the device's light or dark setting, and the pre-paint script in
`src/app/layout.tsx` writes nothing at all. `tests/rendered/theme-storage-on-choice.test.tsx`
and `tests/unit/app/theme-init-script.test.ts` record every write to prove it.

## Not here yet

Recording that a person accepted the terms (which version, when) is
#462. The first-sign-in line informs the person; it records nothing.

## For developers

- `src/lib/legal/texts.ts` reads the texts and decides which exist (`legalHrefs`).
  `LEGAL_CONTENT_DIR` (declared in `src/env.ts`, never set in a deployment)
  points tests at `tests/fixtures/legal`.
- `src/components/legal/LegalDocument.tsx` renders Markdown tokens as the design
  system's elements on the server, never as HTML. It is the only importer of
  `marked`, and no client module imports it, so the pages ship no parser.
- The legal pages have no `loading.tsx`, on purpose: a loading boundary streams
  a `200` before the page runs, and a missing text would become a soft 404.
  `tests/guardrails/route-loading-coverage.test.ts` records why.
- `tests/guardrails/legal-pages.test.ts` holds the rules above: no file in
  `content/legal` but the six texts, the Dockerfile copies the directory, each
  page reads its text through `loadLegalPage`, no file but `texts.ts` spells
  out a legal page's path, and the files that link one ask `legalHrefs`.
