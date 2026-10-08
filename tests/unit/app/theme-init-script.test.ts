import { readFileSync } from 'node:fs';

import { THEME_COOKIE, THEME_STORAGE_KEY } from '@/lib/theme-constants';

/**
 * The root layout's pre-paint theme script, RUN (#370).
 *
 * It writes nothing, as upstream's has since inflect #3270: a theme is stored
 * only when the person picks one (the vendored ThemeProvider). A first visit
 * applies the OS's scheme; a choice in the cookie, or only in localStorage, is
 * applied; none of them is written.
 *
 * The script is a constant inside src/app/layout.tsx, which may export only
 * what Next allows a layout to, so this runs the source itself: the template
 * literal, filled with the same constants. native-feel.test.ts keeps it free of
 * backslashes, which is what makes that safe. Writes are recorded where they
 * land, at the `document.cookie` setter and at `Storage.prototype.setItem`
 * (the method inflect's own test for #3270 records).
 */
const LAYOUT = readFileSync('src/app/layout.tsx', 'utf8');

function theScript() {
  const body = /const THEME_INIT_SCRIPT = `([\s\S]*?)`;/.exec(LAYOUT)?.[1];
  const colours = /const THEME_CHROME = (\{[^}]*\})/.exec(LAYOUT)?.[1];
  if (!body || !colours) throw new Error('layout.tsx: the theme script or its colours moved');
  const chrome = new Function(`return ${colours};`)() as Record<'dark' | 'light', string>;
  const jsToken = (value: string) => `'${value}'`;
  const script = new Function(
    'jsToken',
    'THEME_COOKIE',
    'THEME_STORAGE_KEY',
    'THEME_CHROME',
    `return \`${body}\`;`,
  )(jsToken, THEME_COOKIE, THEME_STORAGE_KEY, chrome) as string;
  return { script, chrome };
}

const { script: SCRIPT, chrome: CHROME } = theScript();

const cookieProp = Object.getOwnPropertyDescriptor(Document.prototype, 'cookie')!;
const setCookie = (v: string) => cookieProp.set!.call(document, v);

let cookieWrites: string[];
let storageWrites: Array<[string, string]>;

/** The OS's colour scheme, as the script asks it. */
function osPrefers(scheme: 'light' | 'dark') {
  window.matchMedia = ((query: string) => ({
    matches: query === '(prefers-color-scheme: light)' ? scheme === 'light' : scheme === 'dark',
    media: query,
  })) as unknown as typeof window.matchMedia;
}

function run() {
  new Function(SCRIPT)();
  return document.documentElement.getAttribute('data-theme');
}

beforeEach(() => {
  setCookie(`${THEME_COOKIE}=; path=/; max-age=0`);
  window.localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
  document.head.innerHTML =
    `<meta name="theme-color" media="(prefers-color-scheme: dark)" content="${CHROME.dark}">` +
    `<meta name="theme-color" media="(prefers-color-scheme: light)" content="${CHROME.light}">`;
  osPrefers('dark');

  cookieWrites = [];
  storageWrites = [];
  Object.defineProperty(document, 'cookie', {
    configurable: true,
    get: () => cookieProp.get!.call(document),
    set: (v: string) => {
      cookieWrites.push(v);
      setCookie(v);
    },
  });
  jest.spyOn(Storage.prototype, 'setItem').mockImplementation(function (
    this: Storage,
    key: string,
    value: string,
  ) {
    storageWrites.push([key, value]);
  });
});

afterEach(() => {
  // Back to the prototype's accessor.
  delete (document as unknown as Record<string, unknown>).cookie;
  jest.restoreAllMocks();
});

describe('a first visit: the OS’s scheme, applied, and nothing stored', () => {
  it.each(['light', 'dark'] as const)('an OS that prefers %s', (scheme) => {
    osPrefers(scheme);
    expect(run()).toBe(scheme);
    expect(cookieWrites).toEqual([]);
    expect(storageWrites).toEqual([]);
    expect(document.cookie).not.toContain(THEME_COOKIE);
  });

  it('a browser with no matchMedia: dark, still nothing stored', () => {
    (window as unknown as { matchMedia?: unknown }).matchMedia = undefined;
    expect(run()).toBe('dark');
    expect(cookieWrites).toEqual([]);
    expect(storageWrites).toEqual([]);
  });

  it('storage that throws on read: the OS’s scheme, nothing stored, nothing thrown', () => {
    osPrefers('light');
    jest.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('The operation is insecure.', 'SecurityError');
    });
    expect(run()).toBe('light');
    expect(cookieWrites).toEqual([]);
    expect(storageWrites).toEqual([]);
  });
});

describe('a choice the visitor made', () => {
  it('in the cookie: applied over the OS, and not written again', () => {
    setCookie(`${THEME_COOKIE}=dark; path=/`);
    osPrefers('light');
    expect(run()).toBe('dark');
    expect(cookieWrites).toEqual([]);
    expect(storageWrites).toEqual([]);
  });

  it('in localStorage only: applied before paint, and not copied into the cookie', () => {
    window.localStorage[THEME_STORAGE_KEY] = 'light';
    osPrefers('dark');
    expect(run()).toBe('light');
    expect(cookieWrites).toEqual([]);
    expect(storageWrites).toEqual([]);
    expect(document.cookie).not.toContain(THEME_COOKIE);
  });

  it('something that is not a theme in localStorage is not a choice: the OS decides', () => {
    window.localStorage[THEME_STORAGE_KEY] = 'sepia';
    osPrefers('light');
    expect(run()).toBe('light');
    expect(cookieWrites).toEqual([]);
  });
});

describe('the browser’s chrome colour', () => {
  it('follows the theme applied, not the OS’s', () => {
    setCookie(`${THEME_COOKIE}=light; path=/`);
    osPrefers('dark');
    run();
    const metas = Array.from(document.querySelectorAll('meta[name="theme-color"]'));
    expect(metas.map((m) => m.getAttribute('content'))).toEqual([CHROME.light, CHROME.light]);
  });
});
