import { readFileSync } from 'node:fs';

/**
 * playerz.bg is dark by default, whatever the device prefers (owner decision
 * 2026-11-27). Two places decide the theme of a visitor who has not picked
 * one, and they must agree or the page flashes: the pre-paint script in the
 * root layout (run in theme-init-script.test.ts) and the vendored
 * ThemeProvider, which follows the OS unless it is told not to.
 */
describe('a visitor who has not picked a theme gets dark', () => {
  it('the provider tree mounts ThemeProvider with followSystem={false}', () => {
    const providers = readFileSync('src/app/providers.tsx', 'utf8');
    expect(providers).toContain('<ThemeProvider followSystem={false}>');
  });
});
