import { existsSync, readFileSync } from 'node:fs';

/**
 * The manifest named three icons for months that did not exist (#432): the
 * installed PWA had no icon and link previews had no image. Every file the
 * manifest names, and the app-directory icons Next serves, must be on disk.
 */
describe('app icons exist (#432)', () => {
  const manifest = JSON.parse(readFileSync('public/manifest.webmanifest', 'utf8')) as {
    icons: { src: string }[];
  };

  it.each(manifest.icons.map((i) => i.src))('the manifest icon %s is in public/', (src) => {
    expect(existsSync(`public${src}`)).toBe(true);
  });

  it.each([
    'src/app/icon.svg',
    'src/app/favicon.ico',
    'src/app/apple-icon.png',
    'src/app/opengraph-image.png',
    'src/app/opengraph-image.alt.txt',
  ])('%s exists', (f) => {
    expect(existsSync(f)).toBe(true);
  });
});
