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

describe('what the club wrote about the venue (#536)', () => {
  const render_ = async (extra: { description?: string | null; phone?: string | null }) =>
    render(
      withIntl(
        await resolveServerTree(await VenueHeader({ ...base, club: null, ...extra })),
        locale,
      ),
    );

  it('shows the description in the club’s own words, line breaks kept', async () => {
    await render_({ description: 'Четири закрити корта.\n\nПаркинг отпред.' });
    const text = screen.getByTestId('venue-description');
    expect(text.textContent).toBe('Четири закрити корта.\n\nПаркинг отпред.');
    expect(text).toHaveClass('whitespace-pre-wrap');
  });

  it('shows the phone as the club wrote it, as a link that dials the digits', async () => {
    await render_({ phone: '02 987 65 43' });
    expect(screen.getByTestId('venue-phone')).toHaveTextContent('Телефон: 02 987 65 43');
    expect(screen.getByRole('link', { name: 'Телефон: 02 987 65 43' })).toHaveAttribute(
      'href',
      'tel:029876543',
    );
  });

  it('a + is kept in the number that is dialled; English says Phone', async () => {
    locale = 'en';
    await render_({ phone: '+359 (2) 987-65-43' });
    expect(screen.getByRole('link', { name: 'Phone: +359 (2) 987-65-43' })).toHaveAttribute(
      'href',
      'tel:+35929876543',
    );
  });

  it('a venue with neither shows neither, and no empty paragraph', async () => {
    await render_({ description: null, phone: null });
    expect(screen.queryByTestId('venue-description')).toBeNull();
    expect(screen.queryByTestId('venue-phone')).toBeNull();
  });
});
