import type { Metadata, Viewport } from 'next';
import { Inter } from 'next/font/google';
import { cookies } from 'next/headers';
import { NextIntlClientProvider } from 'next-intl';
import { getLocale, getMessages, getTranslations } from 'next-intl/server';

// From the SERVER-SAFE module, never from ThemeProvider ('use client'): a
// server import of a client module's constant is a client-reference proxy, not
// the string — which is how `cookies().get(THEME_COOKIE)` silently always missed
// in upstream. See src/lib/theme-constants.ts.
import { THEME_COOKIE, THEME_STORAGE_KEY, type Theme } from '@/lib/theme-constants';

import { Providers } from './providers';

import './globals.css';

/**
 * Inter, SELF-HOSTED (#266).
 *
 * It was a `@import url(fonts.googleapis.com/…)` at the top of globals.css:
 * a render-blocking chain — our CSS, then Google's CSS, then the woff2 from a
 * third origin, each a fresh DNS + TLS handshake on a phone — that PR #268's
 * baseline measured at about 250 ms of first paint on every full load. It also
 * asked for six DISCRETE weights (300…800), so `font-[560]` quietly rendered
 * as 500 or 600.
 *
 * next/font downloads the files at build time and serves them from
 * /_next/static/media — same origin, preloaded, cached by the service worker
 * as a shell asset, and no visitor's IP reaches Google. Omitting `weight`
 * takes the VARIABLE font (100…900). Cyrillic is not optional: Bulgarian is the
 * default locale, and without the subset every Cyrillic glyph falls back to
 * system-ui mid-word. tests/guardrails/no-third-party-fonts.test.ts keeps the
 * @import from coming back.
 */
const inter = Inter({
  subsets: ['latin', 'cyrillic'],
  display: 'swap',
  variable: '--font-inter',
});

/**
 * The OS/browser chrome colour per theme — the ACTUAL `--bg-page` tokens (see
 * `viewport.themeColor` below and tests/guardrails/native-feel.test.ts).
 * Defined once so the viewport pair and the pre-paint script cannot disagree.
 */
const THEME_CHROME = { dark: '#0b0b12', light: '#f4f2ed' } as const satisfies Record<Theme, string>;

/**
 * A constant, quoted as a JS string literal for the inline script below.
 *
 * It was `JSON.stringify(...)`, which CodeQL flags as improper code
 * sanitization (js/bad-code-sanitization, alerts 88-90 on PR #283): JSON does
 * not escape `<`, `/` or U+2028, so a value containing `</script>` would break
 * out of the tag. These values are compile-time constants, but T17 renames the
 * keys, so instead of trusting them we ALLOW-LIST them: a cookie name, a
 * storage key or a hex colour needs nothing beyond letters, digits and `_:#-`.
 * Anything else throws at module load (a build failure, never a quietly broken
 * or injectable script). The allow-list also keeps the script free of
 * backslashes (see below).
 */
function jsToken(value: string): string {
  if (!/^[A-Za-z0-9_:#-]+$/.test(value)) {
    throw new Error(`layout: refusing to inline ${value} into the theme script`);
  }
  return `'${value}'`;
}

/**
 * The pre-paint theme script — the SECOND line of defence behind the cookie.
 *
 * A returning visitor's `<html>` already carries `data-theme` from the cookie
 * (below), so no script has to win a race against first paint. This only
 * matters on a FIRST visit, or on the one force-static page (/offline) where
 * there is no request and `cookies()` is empty: it resolves cookie →
 * localStorage → `prefers-color-scheme` → dark, sets `data-theme` before the
 * body paints, and writes the cookie so the next SSR is already right.
 *
 * Without it a light-preferring visitor saw the dark `:root` palette until
 * ThemeProvider's mount effect ran — a full dark→light flash, and a 150 ms
 * button transition that axe once sampled mid-flight (#115).
 *
 * It also points `<meta name="theme-color">` at the chosen theme, because the
 * layout's pair is keyed on the OS scheme, not ours. The metas may not be
 * parsed yet when this runs, so it retries at DOMContentLoaded; the providers
 * take over from there.
 *
 * Built from the constants, never literals: T17 renames the keys, and a script
 * that disagrees with ThemeProvider is a flash that comes back on every load.
 *
 * NO BACKSLASHES in it. The cookie regex was first written `;\\s*` / `\\b`,
 * one escaping level short: the browser received `'\s'` (just `s`) and `'\b'`
 * (a backspace), the match never hit, and a dark-cookie visitor on a light OS
 * was flipped to light AND had the cookie overwritten — caught by
 * design-system-dark-axe.spec.ts. `document.cookie` always joins with "; ",
 * so the pattern needs no escapes at all; native-feel.test.ts keeps it so.
 */
const THEME_INIT_SCRIPT = `(function(){try{var d=document.documentElement;var ck=${jsToken(THEME_COOKIE)};var lk=${jsToken(
  THEME_STORAGE_KEY,
)};var c={dark:${jsToken(THEME_CHROME.dark)},light:${jsToken(THEME_CHROME.light)}};var t=null;var m=document.cookie.match(new RegExp('(?:^|; )'+ck+'=(light|dark)(?:;|$)'));if(m){t=m[1];}if(!t){var s=null;try{s=localStorage.getItem(lk);}catch(e){}if(s==='light'||s==='dark'){t=s;}}if(!t){t=(window.matchMedia&&window.matchMedia('(prefers-color-scheme: light)').matches)?'light':'dark';}d.setAttribute('data-theme',t);var sec=location.protocol==='https:'?'; secure':'';document.cookie=ck+'='+t+'; path=/; max-age=31536000; samesite=lax'+sec;var f=function(){var n=document.querySelectorAll('meta[name="theme-color"]');for(var i=0;i<n.length;i++){n[i].setAttribute('content',c[d.getAttribute('data-theme')]||c[t]);}};f();document.addEventListener('DOMContentLoaded',f);}catch(e){}})();`;

/**
 * The defaults every page inherits. The description is in the request's
 * language (#368): it was an English literal, so every page without its own
 * (/venues, /login, the invitations, the 404) described itself in English to
 * a Bulgarian reader and in search results.
 */
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('common');
  return { ...BASE_METADATA, description: t('metaDescription') };
}

const BASE_METADATA: Metadata = {
  title: 'playerz.bg',
  manifest: '/manifest.webmanifest',
  appleWebApp: {
    // Installed to the home screen, the app should not render the browser's
    // status-bar chrome over its own header.
    capable: true,
    statusBarStyle: 'black-translucent',
    title: 'playerz',
  },
};

export const viewport: Viewport = {
  /**
   * THE OS/BROWSER CHROME COLOUR.
   *
   * It was not set at all — and that bites NOW, because we ship a PWA (P22) and
   * two themes (P23). Installed to a home screen, the status bar and the address
   * bar were rendering in the browser's default grey, matching NEITHER theme. The
   * app looked like a web page in a frame rather than an app.
   *
   * A single colour would be no better: it would be right in one theme and wrong
   * in the other. So it is a PAIR, keyed on the same media query the design system
   * uses, and the values are the actual `--bg-page` tokens — not approximations.
   * A chrome colour that is *nearly* the page background is more obviously wrong
   * than one that is completely different, because the seam is visible.
   */
  themeColor: [
    { media: '(prefers-color-scheme: dark)', color: THEME_CHROME.dark },
    { media: '(prefers-color-scheme: light)', color: THEME_CHROME.light },
  ],

  // `viewport-fit=cover` is what makes env(safe-area-inset-*) return anything
  // other than 0. Without it the safe-area utilities added in globals.css are
  // silently no-ops and the notch still eats the header.
  viewportFit: 'cover',
  width: 'device-width',
  initialScale: 1,
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // The ported primitives call useTranslations(), so the provider has to
  // wrap the whole tree — without it every one of them throws during
  // prerender.
  const locale = await getLocale();
  const messages = await getMessages();

  // Flash-proof theme: the cookie ThemeProvider writes is read here, so a
  // returning visitor's FIRST byte is already their theme. With no cookie
  // (first visit, or /offline, which is force-static and so has no request)
  // the attribute is omitted and the pre-paint script decides.
  const cookieTheme = (await cookies()).get(THEME_COOKIE)?.value;
  const initialTheme: Theme | undefined =
    cookieTheme === 'light' || cookieTheme === 'dark' ? cookieTheme : undefined;

  return (
    // suppressHydrationWarning: on a first visit the pre-paint script adds
    // data-theme before React hydrates, so <html> legitimately differs from
    // the server's.
    <html
      lang={locale}
      data-theme={initialTheme}
      className={inter.variable}
      suppressHydrationWarning
    >
      <head>
        <script suppressHydrationWarning dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body>
        {/* NextIntlClientProvider OUTSIDE Providers: the Toaster and the
            primitives the providers render call useTranslations(), and would
            throw during SSR with no intl context above them. */}
        <NextIntlClientProvider locale={locale} messages={messages}>
          <Providers>{children}</Providers>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
