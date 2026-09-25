import { render, screen } from '@testing-library/react';

import bg from '../../messages/bg.json';
import en from '../../messages/en.json';

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
 * ═══ WHY THIS TESTS THE CATALOGUE AND NOT THE COMPONENT ═══
 *
 * `not-found.tsx` is an async server component calling
 * `getTranslations` from `next-intl/server`, which sits behind a `react-server`
 * export condition — importing it under jest fails, and this repo has already
 * been bitten by exactly that (the `notifyAfterCommit` work). Rendering it here
 * would test the harness rather than the page.
 *
 * What CAN go wrong and is worth pinning: the keys it reads not existing, or
 * existing only in English. A missing key renders as the bare key name, so the
 * user sees `notFound.title` — which is worse than the English it replaced.
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

  it('renders the shape the page renders, from the real catalogue', () => {
    // A stand-in for the server component: same strings, same structure, so the
    // copy is exercised as copy rather than only as JSON. It asserts the
    // catalogue reads naturally in place, which a key-existence check cannot.
    render(
      <main>
        <h1>{bg.notFound.title}</h1>
        <p>{bg.notFound.body}</p>
        <a href="/venues">{bg.notFound.backToVenues}</a>
      </main>,
    );

    expect(screen.getByRole('heading', { name: bg.notFound.title })).toBeInTheDocument();
    // /venues is the one substantial page that currently exists, which is why it
    // is the only link offered.
    expect(screen.getByRole('link', { name: bg.notFound.backToVenues })).toHaveAttribute(
      'href',
      '/venues',
    );
  });
});
