import { act, fireEvent, render, screen } from '@testing-library/react';

import { ThemeProvider, useTheme } from '@/components/theme/ThemeProvider';
import { THEME_COOKIE, THEME_STORAGE_KEY } from '@/lib/theme-constants';

/**
 * The vendored ThemeProvider stores a theme only when the person picks one
 * (inflect #3270, re-vendored at fcb7771; #370's essential-only cookie
 * notice). Mirrors upstream's own test of the same name: writes are recorded
 * where they land, at the `document.cookie` setter and at
 * `Storage.prototype.setItem`.
 *
 *   a first visit      follows the OS and writes nothing
 *   a stored choice    is applied and not written again
 *   a toggle           writes both: the cookie (for the server) and localStorage
 *   the OS changing    moves an unchosen theme live, writing nothing, and never
 *                      a chosen one
 *
 * The root layout's own pre-paint script is tests/unit/app/theme-init-script.test.ts.
 */

function Toggle() {
  const { theme, toggle } = useTheme();
  return (
    <button type="button" onClick={toggle}>
      {theme}
    </button>
  );
}

const cookieProp = Object.getOwnPropertyDescriptor(Document.prototype, 'cookie')!;
const setCookie = (v: string) => cookieProp.set!.call(document, v);

let cookieWrites: string[];
let storageWrites: Array<[string, string]>;
/** The OS scheme the page sees, and the listeners waiting for it to change. */
let osLight: boolean;
let listeners: Array<(e: { matches: boolean }) => void>;

function osSwitchesTo(scheme: 'light' | 'dark') {
  osLight = scheme === 'light';
  act(() => {
    for (const l of listeners) l({ matches: osLight });
  });
}

beforeEach(() => {
  setCookie(`${THEME_COOKIE}=; path=/; max-age=0`);
  window.localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
  osLight = false;
  listeners = [];
  window.matchMedia = ((query: string) => ({
    get matches() {
      return query === '(prefers-color-scheme: light)' ? osLight : !osLight;
    },
    media: query,
    addEventListener: (_: string, l: (e: { matches: boolean }) => void) => listeners.push(l),
    removeEventListener: (_: string, l: (e: { matches: boolean }) => void) => {
      listeners = listeners.filter((x) => x !== l);
    },
  })) as unknown as typeof window.matchMedia;

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
  const realSetItem = Storage.prototype.setItem;
  jest.spyOn(Storage.prototype, 'setItem').mockImplementation(function (
    this: Storage,
    key: string,
    value: string,
  ) {
    storageWrites.push([key, value]);
    realSetItem.call(this, key, value);
  });
});

afterEach(() => {
  delete (document as unknown as Record<string, unknown>).cookie;
  jest.restoreAllMocks();
});

const mount = () =>
  render(
    <ThemeProvider>
      <Toggle />
    </ThemeProvider>,
  );

describe('the theme is stored only on a choice (inflect #3270)', () => {
  it('a first visit follows the OS and writes nothing', async () => {
    osLight = true;
    mount();
    await act(async () => {});
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    expect(screen.getByRole('button')).toHaveTextContent('light');
    expect(cookieWrites).toEqual([]);
    expect(storageWrites).toEqual([]);
  });

  it('a stored choice is applied, and not written again on mount', async () => {
    window.localStorage[THEME_STORAGE_KEY] = 'light';
    mount();
    await act(async () => {});
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    expect(cookieWrites).toEqual([]);
    expect(storageWrites).toEqual([]);
  });

  it('a toggle writes both: the cookie for the server, and localStorage', async () => {
    mount();
    await act(async () => {});
    fireEvent.click(screen.getByRole('button'));
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    expect(storageWrites).toEqual([[THEME_STORAGE_KEY, 'light']]);
    expect(cookieWrites).toHaveLength(1);
    expect(cookieWrites[0]).toMatch(new RegExp(`^${THEME_COOKIE}=light; path=/; max-age=\\d+`));
  });

  it('with nothing chosen, the OS changing moves the theme live, and nothing is written', async () => {
    mount();
    await act(async () => {});
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    osSwitchesTo('light');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    expect(cookieWrites).toEqual([]);
    expect(storageWrites).toEqual([]);
  });

  it('once chosen, the OS no longer moves it', async () => {
    mount();
    await act(async () => {});
    fireEvent.click(screen.getByRole('button')); // dark → light, chosen
    osSwitchesTo('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });
});
