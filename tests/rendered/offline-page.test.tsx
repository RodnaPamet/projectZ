import { render, screen } from '@testing-library/react';

import OfflinePage from '@/app/offline/page';

import bg from '../../messages/bg.json';
import en from '../../messages/en.json';
import { withIntl } from '../helpers/intl';
import { resolveServerTree } from '../helpers/server-tree';

/**
 * The offline page says it in every language (#431). It is static, so it has
 * no cookie to read and cannot know which one its reader chose.
 */

jest.mock('next-intl/server', () => {
  const { createTranslator } = jest.requireActual('next-intl');
  return {
    // The static render has no request: the default locale.
    getTranslations: async (namespace: string) =>
      createTranslator({
        locale: 'bg',
        messages: require('../../messages/bg.json'),
        namespace,
      }),
  };
});

describe('the offline page', () => {
  it('is in Bulgarian first, as the page’s own language, with one heading', async () => {
    render(withIntl(await resolveServerTree(await OfflinePage())));
    expect(screen.getAllByRole('heading')).toHaveLength(1);
    expect(screen.getByRole('heading', { level: 1, name: bg.offline.title })).toBeInTheDocument();
    expect(screen.getByText(bg.offline.body)).toBeInTheDocument();
  });

  it('says the same in English beneath it, marked as English for a screen reader', async () => {
    render(withIntl(await resolveServerTree(await OfflinePage())));
    const english = screen.getByTestId('offline-en');
    expect(english).toHaveAttribute('lang', 'en');
    expect(english).toHaveTextContent(en.offline.title);
    expect(english).toHaveTextContent(en.offline.body);
    // The Bulgarian text is not inside the block marked English.
    expect(english).not.toHaveTextContent(bg.offline.title);
  });

  it('stays static: no request, no cookie, nothing personal', async () => {
    const mod = await import('@/app/offline/page');
    expect(mod.dynamic).toBe('force-static');
  });
});
