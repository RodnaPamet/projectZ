import { render, screen } from '@testing-library/react';

import NotFound from '@/app/not-found';

import bg from '../../messages/bg.json';
import en from '../../messages/en.json';

jest.mock('next-intl/server', () => ({
  getTranslations: async (ns: string) => (key: string) =>
    (require('../../messages/bg.json') as Record<string, Record<string, string>>)[ns]![key],
}));

/**
 * THE 404 IS THE PAGE MOST LIKELY TO BE SEEN BY SOMEBODY WHO DOES NOT READ ENGLISH.
 *
 * Arriving here means something already went wrong, and there was no
 * `not-found.tsx` at all — so an unknown address got Next's built-in page, in
 * English, with none of this product's chrome, in an app whose default locale is
 * Bulgarian.
 *
 * Not hypothetical: eight of the nine `AppNav` links point at pages that do not
 * exist yet (#176), and the player half of that nav is not permission-gated, so a
 * signed-out visitor is three clicks away.
 *
 * ═══ THE CATALOGUE, AND THEN THE COMPONENT ═══
 *
 * `not-found.tsx` is an async server component calling `getTranslations` from
 * `next-intl/server`, which sits behind a `react-server` export condition —
 * importing it under jest fails (the `notifyAfterCommit` work hit exactly
 * that). So that one module is mocked with a lookup in the real catalogue,
 * and the page itself is rendered (T27); before, a hand-written stand-in was.
 *
 * The catalogue checks stay: the keys it reads not existing, or existing only
 * in English. A missing key renders as the bare key name, so the user sees
 * `notFound.title` — which is worse than the English it replaced.
 */

const KEYS = ['title', 'body', 'backToVenues'] as const;

describe('the 404 page has copy in both locales', () => {
  it('bg carries every key the page reads', () => {
    for (const k of KEYS) {
      expect(bg.notFound?.[k as keyof typeof bg.notFound]).toBeTruthy();
    }
  });

  it('en carries every key too, so a language switch does not regress', () => {
    for (const k of KEYS) {
      expect(en.notFound?.[k as keyof typeof en.notFound]).toBeTruthy();
    }
  });

  it('the Bulgarian is actually Bulgarian', () => {
    // The failure this catches is a catalogue where `bg` was filled in with the
    // English string as a placeholder — which passes a "key exists" check and
    // ships English to every user.
    const cyrillic = /[Ѐ-ӿ]/;
    for (const k of KEYS) {
      expect(bg.notFound[k as keyof typeof bg.notFound]).toMatch(cyrillic);
    }
  });

  it('bg and en say different things', () => {
    // Belt and braces on the same failure: identical strings mean one of them
    // was copied.
    for (const k of KEYS) {
      expect(bg.notFound[k as keyof typeof bg.notFound]).not.toBe(
        en.notFound[k as keyof typeof en.notFound],
      );
    }
  });

  it('renders the page itself, from the real catalogue', async () => {
    // The real component, with `next-intl/server` swapped for a lookup in the
    // real catalogue (mocked above, so its `react-server` condition is never
    // resolved). It asserts the copy reads in place AND that the page is
    // built from the primitives, which a stand-in could not.
    render(await NotFound());

    expect(screen.getByRole('heading', { level: 1, name: bg.notFound.title })).toBeInTheDocument();
    // /venues is the one substantial page that currently exists, which is why it
    // is the only link offered.
    const link = screen.getByRole('link', { name: bg.notFound.backToVenues });
    expect(link).toHaveAttribute('href', '/venues');
    // The way out is the primary button's recipe (a pill, 44 px on touch), not
    // an underlined footnote.
    expect(link.className).toMatch(/rounded-full/);
    expect(link.className).toMatch(/pointer-coarse:min-h-11/);
  });
});
