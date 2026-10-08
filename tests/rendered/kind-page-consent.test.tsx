import { render, screen, within } from '@testing-library/react';
import { SWRConfig } from 'swr';

import KindChooserPage from '@/app/(app)/start/kind/page';

import { messages, withIntl } from '../helpers/intl';
import { resolveServerTree } from '../helpers/server-tree';

/**
 * The first-sign-in screen's line (#360, #370): "Продължавайки, приемате
 * Общите условия и Политиката за поверителност", linking both, and only when
 * both texts exist in the page's language. Recording the acceptance is
 * #462; the line is the notice.
 */

jest.mock('next-intl/server', () => {
  const { createTranslator } = jest.requireActual('next-intl');
  return {
    getLocale: async () => 'bg',
    getTranslations: async (namespace: string) =>
      createTranslator({ locale: 'bg', messages: require('../../messages/bg.json'), namespace }),
  };
});

jest.mock('@/lib/auth/page-context', () => ({
  requireSignedIn: async () => 'cuser000000000000000000001',
}));
jest.mock('@/app-layer/usecases/account-kind', () => ({
  readMyAccountKind: async () => null,
}));
jest.mock('@/app-layer/usecases/landing', () => ({
  resolveLanding: async () => ({ href: '/venues' }),
}));

let hrefs: { privacy: string | null; terms: string | null; cookies: string | null };
jest.mock('@/lib/legal/texts', () => ({
  legalHrefs: async () => hrefs,
}));

async function renderPage() {
  const tree = await resolveServerTree(
    await KindChooserPage({ searchParams: Promise.resolve({}) }),
  );
  return render(withIntl(<SWRConfig value={{ provider: () => new Map() }}>{tree}</SWRConfig>));
}

describe('/start/kind’s consent line (#370)', () => {
  it('with both texts: the sentence, linking the terms and the privacy policy', async () => {
    hrefs = { privacy: '/privacy', terms: '/terms', cookies: null };
    await renderPage();
    const line = screen.getByTestId('kind-consent');
    expect(line).toHaveTextContent(
      'Продължавайки, приемате Общите условия и Политиката за поверителност.',
    );
    expect(within(line).getByRole('link', { name: 'Общите условия' })).toHaveAttribute(
      'href',
      '/terms',
    );
    expect(within(line).getByRole('link', { name: 'Политиката за поверителност' })).toHaveAttribute(
      'href',
      '/privacy',
    );
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(
      messages.onboarding.kind.title,
    );
  });

  it.each([
    [{ privacy: null, terms: null, cookies: null }],
    [{ privacy: '/privacy', terms: null, cookies: '/cookies' }],
    [{ privacy: null, terms: '/terms', cookies: null }],
  ])('without both texts (%j): no line, and nothing links to a 404', async (h) => {
    hrefs = h;
    await renderPage();
    expect(screen.queryByTestId('kind-consent')).toBeNull();
  });
});
