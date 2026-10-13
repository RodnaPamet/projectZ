import { globSync, readFileSync } from 'node:fs';

/**
 * EVERY PLATFORM PAGE SENDS A SIGNED-OUT VISITOR TO SIGN-IN, BACK TO ITSELF (#520).
 *
 * The platform layout used to redirect signed-out visitors itself, but a
 * layout doesn't know the request path, so every page returned to
 * /platform/moderation after sign-in. The layout now renders only the page
 * when signed out, and each page redirects with its own `next`. A page
 * without that redirect would render with no chrome and no sign-in, so this
 * fails on it.
 */
const PAGES = globSync('src/app/(app)/platform/**/page.tsx').map(String).sort();

describe('platform pages redirect a signed-out visitor themselves (#520)', () => {
  it('finds the pages', () => {
    expect(PAGES.length).toBeGreaterThan(5);
  });

  it.each(PAGES)('%s redirects to /login with a next', (file) => {
    const src = readFileSync(file, 'utf8');
    expect(src).toMatch(/redirect\(\s*[`'"]\/login\?next=/);
  });
});
