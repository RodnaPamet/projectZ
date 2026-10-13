import { render, screen } from '@testing-library/react';

import { VenueHeader } from '@/app/(public)/venues/[slug]/VenueHeader';

import { withIntl } from '../helpers/intl';
import { resolveServerTree } from '../helpers/server-tree';

/**
 * The venue header names the club that runs the venue, as a link to the
 * club's page (#410): the way from one venue to the club's other venues.
 */

let locale: 'bg' | 'en' = 'bg';
jest.mock('next-intl/server', () => {
  const { createTranslator } = jest.requireActual('next-intl');
  return {
    getLocale: async () => locale,
    getTranslations: async (namespace: string) =>
      createTranslator({
        locale,
        messages:
          locale === 'en' ? require('../../messages/en.json') : require('../../messages/bg.json'),
        namespace,
      }),
  };
});

beforeEach(() => {
  locale = 'bg';
});

const base = { name: 'Малеева Лозенец', addressLine: 'ул. Тест 1', city: 'София', sports: [] };

async function renderHeader(club: { name: string; href: string } | null) {
  return render(withIntl(await resolveServerTree(await VenueHeader({ ...base, club })), locale));
}

describe('the venue header’s club link (#410)', () => {
  it('links the club by name to its page, in Bulgarian', async () => {
    await renderHeader({ name: 'Тенис клуб Малееви', href: '/clubs/maleeva-club' });
    expect(screen.getByTestId('venue-club')).toHaveTextContent('Обект на Тенис клуб Малееви');
    const link = screen.getByRole('link', { name: 'Тенис клуб Малееви' });
    expect(link).toHaveAttribute('href', '/clubs/maleeva-club');
  });

  it('and in English', async () => {
    locale = 'en';
    await renderHeader({ name: 'Maleeva Club', href: '/clubs/maleeva-club' });
    expect(screen.getByTestId('venue-club')).toHaveTextContent('Run by Maleeva Club');
    expect(screen.getByRole('link', { name: 'Maleeva Club' })).toHaveAttribute(
      'href',
      '/clubs/maleeva-club',
    );
  });

  it('without a club there is no line and no empty link', async () => {
    await renderHeader(null);
    expect(screen.queryByTestId('venue-club')).toBeNull();
  });
});
