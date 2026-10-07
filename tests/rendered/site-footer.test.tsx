import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { SiteFooter } from '@/components/layout/site-footer';

import { withIntl } from '../helpers/intl';
import { resolveServerTree } from '../helpers/server-tree';

import bg from '../../messages/bg.json';
import en from '../../messages/en.json';

/**
 * THE PUBLIC FOOTER'S LANGUAGE SWITCH (#368).
 *
 * A visitor who is not signed in had no way to read the site in English: the
 * only switch was on /me/profile (#362). The footer carries the vendored
 * `LocaleSwitcher` on every public page. Signed out, the cookie is the whole
 * preference; signed in, the user record is written first, as the profile's
 * switch does, or the middleware would flip the page straight back.
 */

let locale: 'bg' | 'en' = 'bg';
jest.mock('next-intl/server', () => {
  const { createTranslator } = jest.requireActual('next-intl');
  return {
    getTranslations: async (namespace: string) =>
      createTranslator({
        locale,
        messages:
          locale === 'en' ? require('../../messages/en.json') : require('../../messages/bg.json'),
        namespace,
      }),
  };
});

const refresh = jest.fn();
jest.mock('next/navigation', () => ({
  ...jest.requireActual('next/navigation'),
  useRouter: () => ({ refresh, push: jest.fn(), replace: jest.fn(), prefetch: jest.fn() }),
}));

const persistMyLocale = jest.fn();
jest.mock('@/lib/i18n/persist-my-locale', () => ({
  persistMyLocale: (...a: unknown[]) => persistMyLocale(...a),
}));

function clearLocaleCookie() {
  document.cookie = 'NEXT_LOCALE=; path=/; max-age=0';
}

beforeEach(() => {
  refresh.mockReset();
  persistMyLocale.mockReset();
  clearLocaleCookie();
});

async function renderFooter(l: 'bg' | 'en', signedIn: boolean) {
  locale = l;
  return render(withIntl(await resolveServerTree(<SiteFooter signedIn={signedIn} />), l));
}

describe.each([
  ['bg', bg],
  ['en', en],
] as const)('the footer in %s', (l, messages) => {
  it('names the site, links the courts and the clubs section, and offers both languages', async () => {
    await renderFooter(l, false);
    const footer = screen.getByTestId('site-footer');
    expect(footer).toHaveAttribute('aria-label', messages.common.footer.label);
    expect(
      within(footer).getByRole('link', { name: messages.common.footer.venues }),
    ).toHaveAttribute('href', '/venues');
    expect(
      within(footer).getByRole('link', { name: messages.common.footer.forClubs }),
    ).toHaveAttribute('href', '/#clubs');
    const lang = screen.getByTestId('footer-language');
    expect(lang).toHaveTextContent(messages.common.footer.language);
    expect(within(lang).getByRole('radio', { name: 'Български' })).toBeInTheDocument();
    expect(within(lang).getByRole('radio', { name: 'English' })).toBeInTheDocument();
  });
});

/**
 * #431, inflect #3201: the vendored switch named its radio group with the
 * literal "Language", so a screen reader said it in English on the Bulgarian
 * page. The name now comes from the catalogue's `common.language`.
 */
describe('the switch speaks the page language', () => {
  it.each([
    ['bg', 'Език'],
    ['en', 'Language'],
  ] as const)('%s: the radio group is named "%s"', async (l, name) => {
    await renderFooter(l, false);
    const lang = screen.getByTestId('footer-language');
    expect(within(lang).getByRole('radiogroup')).toHaveAccessibleName(name);
  });

  /**
   * Every text node, and the attributes a screen reader reads. Node by node,
   * because the switch's code and endonym are adjacent spans ("БГ", then
   * "Български" for screen readers) and textContent would run them together.
   */
  const allCopy = (container: HTMLElement) => {
    const texts: string[] = [];
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) texts.push(n.textContent ?? '');
    const attrs = [...container.querySelectorAll('[aria-label],[title],[alt]')].flatMap((el) =>
      ['aria-label', 'title', 'alt'].map((a) => el.getAttribute(a) ?? ''),
    );
    return [...texts, ...attrs].join(' ');
  };

  it('in Bulgarian, no English word but the brand and the English endonym', async () => {
    const { container } = await renderFooter('bg', false);
    const latin = (allCopy(container).match(/[A-Za-z]{3,}/g) ?? []).filter(
      (w) => !['playerz', 'English'].includes(w),
    );
    expect(latin).toEqual([]);
  });

  it('in English, no Cyrillic word but the Bulgarian endonym and its code', async () => {
    const { container } = await renderFooter('en', false);
    const cyrillic = (allCopy(container).match(/[Ѐ-ӿ]+/g) ?? []).filter(
      (w) => !['Български', 'БГ'].includes(w),
    );
    expect(cyrillic).toEqual([]);
  });
});

describe('switching language from the footer', () => {
  it('signed out: writes the NEXT_LOCALE cookie and re-renders, touching no user record', async () => {
    await renderFooter('bg', false);
    await userEvent.click(screen.getByRole('radio', { name: 'English' }));
    expect(document.cookie).toContain('NEXT_LOCALE=en');
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    expect(persistMyLocale).not.toHaveBeenCalled();
  });

  it('signed in: saves the preference on the user first, then the cookie', async () => {
    persistMyLocale.mockImplementation(async () => {
      // The record is written BEFORE the cookie, or the middleware would
      // re-seed the old language from the token.
      expect(document.cookie).not.toContain('NEXT_LOCALE=en');
    });
    await renderFooter('bg', true);
    await userEvent.click(screen.getByRole('radio', { name: 'English' }));
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    expect(persistMyLocale).toHaveBeenCalledWith('en');
    expect(document.cookie).toContain('NEXT_LOCALE=en');
  });

  it('signed in, the save failing: no cookie, no refresh, Bulgarian stays selected', async () => {
    persistMyLocale.mockRejectedValue(new Error('locale not saved'));
    await renderFooter('bg', true);
    await userEvent.click(screen.getByRole('radio', { name: 'English' }));
    await waitFor(() => expect(persistMyLocale).toHaveBeenCalled());
    expect(refresh).not.toHaveBeenCalled();
    expect(document.cookie).not.toContain('NEXT_LOCALE=en');
    expect(screen.getByRole('radio', { name: 'Български' })).toBeChecked();
  });
});
