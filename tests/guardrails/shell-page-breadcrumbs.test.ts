import { globSync, readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * EVERY SHELL PAGE PUSHES ITS TRAIL, OR SAYS WHY NOT (#362, owner 2026-10-08).
 *
 * From `md` the top bar's left slot is the page's breadcrumbs, as upstream's
 * `TopChrome` draws them: whatever the page pushed through the vendored
 * `PageBreadcrumbs`. A page that pushes nothing leaves the slot empty (a
 * screen-reader sentinel), and since the wordmark is the phone's alone, the
 * bar then says nothing at all about where the account is. Upstream holds its
 * own pages to this with `page-breadcrumbs-coverage`; this is playerz's.
 *
 * The population is every `page.tsx` under a layout that draws a shell: the
 * site's pages (`(public)`, which a signed-in account sees in its shell), the
 * club admin and the platform. Text-level, as upstream's: a page that renders
 * `<PageBreadcrumbs` passes. An exemption names why, in more than 40
 * characters, and a stale one fails.
 */

const APP = 'src/app';
const SHELL_ROOTS = ['(public)', '(app)/t/[slug]/admin', '(app)/platform'];

/** Page directory (relative to src/app) → why it pushes no trail. */
const EXEMPT: Record<string, string> = {
  '(public)/login':
    'the sign-in page: an account that is signed in has no place in the app that leads to it',
  '(public)/invite/[token]':
    'an invitation, reached from a link in an email and never from the nav, so it has no trail',
  '(public)/invite/booking/[token]':
    'an invitation to a booking, reached from a shared link and never from the nav, so no trail',
  '(app)/platform':
    'redirect-only index (#345): it sends a grant holder to the first platform page, which pushes',
};

const pages = globSync(`${APP}/**/page.tsx`)
  .map((f) => path.relative(APP, path.dirname(f.toString())).split(path.sep).join('/'))
  .filter((dir) => SHELL_ROOTS.some((root) => dir === root || dir.startsWith(`${root}/`)))
  .sort();

const pushes = (source: string) => /<PageBreadcrumbs\b/.test(source);

describe('every shell page pushes its breadcrumbs', () => {
  it('finds the pages it is meant to cover', () => {
    expect(pages).toEqual(
      expect.arrayContaining([
        '(public)/venues',
        '(public)/venues/[slug]',
        '(public)/me/bookings/[id]',
        '(app)/t/[slug]/admin/courts',
        '(app)/platform/moderation',
      ]),
    );
  });

  it.each(pages)('%s pushes a trail, or says why not', (dir) => {
    if (EXEMPT[dir]) return;
    const source = readFileSync(path.join(APP, dir, 'page.tsx'), 'utf8');
    expect({ dir, pushes: pushes(source) }).toEqual({ dir, pushes: true });
  });

  it.each(Object.entries(EXEMPT))('exemption %s is current and says why', (dir, why) => {
    expect(pages).toContain(dir);
    expect(why.length).toBeGreaterThan(40);
    // An exempt page that pushes after all should leave the list.
    expect(pushes(readFileSync(path.join(APP, dir, 'page.tsx'), 'utf8'))).toBe(false);
  });

  it('negative control: a page with a heading and no push does not pass', () => {
    expect(pushes('return <Heading level={1}>{t("title")}</Heading>;')).toBe(false);
    expect(pushes('<PageBreadcrumbs items={playCrumbs(t)} />')).toBe(true);
  });
});
