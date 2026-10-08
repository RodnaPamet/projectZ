import path from 'node:path';

import { render, screen, within } from '@testing-library/react';

import CookiesPage from '@/app/(public)/cookies/page';
import PrivacyPage, { generateMetadata as privacyMetadata } from '@/app/(public)/privacy/page';
import TermsPage from '@/app/(public)/terms/page';
import { LegalDocument, legalTitle } from '@/components/legal/LegalDocument';

import { resolveServerTree } from '../helpers/server-tree';
import { withIntl } from '../helpers/intl';

/**
 * /privacy, /terms and /cookies (#370): a page renders its text when the file
 * is there, and is a 404 when it is not. Against fixtures, never a real text:
 * tests/fixtures/legal holds a Bulgarian privacy fixture with a title, an
 * English one without, an empty Bulgarian terms file, and no cookies file.
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

const notFound = jest.fn(() => {
  throw new Error('NEXT_HTTP_ERROR_FALLBACK;404');
});
jest.mock('next/navigation', () => ({
  ...jest.requireActual('next/navigation'),
  notFound: () => notFound(),
}));

const FIXTURES = path.join(process.cwd(), 'tests', 'fixtures', 'legal');
const previous = process.env.LEGAL_CONTENT_DIR;

beforeAll(() => {
  process.env.LEGAL_CONTENT_DIR = FIXTURES;
});
afterAll(() => {
  if (previous === undefined) delete process.env.LEGAL_CONTENT_DIR;
  else process.env.LEGAL_CONTENT_DIR = previous;
});
beforeEach(() => {
  locale = 'bg';
  notFound.mockClear();
});

async function renderPage(page: () => Promise<React.ReactNode>) {
  return render(withIntl(await resolveServerTree(await page()), locale));
}

describe('a legal page whose text exists', () => {
  it('renders it, on the server, title first, in the design system’s type', async () => {
    await renderPage(PrivacyPage);
    const doc = screen.getByTestId('legal-document');
    expect(screen.getByRole('heading', { level: 1, name: 'Тестов документ' })).toBeInTheDocument();
    expect(within(doc).getByRole('heading', { level: 2, name: 'Първа част' })).toBeInTheDocument();
    expect(within(doc).getByText('тестов', { selector: 'strong' })).toBeInTheDocument();
    expect(within(doc).getByRole('link', { name: 'бисквитките' })).toHaveAttribute(
      'href',
      '/cookies',
    );
    expect(doc.querySelectorAll('ol > li')).toHaveLength(2);
    expect(doc.querySelectorAll('ul > li')).toHaveLength(2);
    expect(within(doc).getByRole('table')).toHaveTextContent('Стойност');
  });

  it('drops raw HTML and refuses a link that is not http, mail, tel or a path', async () => {
    const { container } = await renderPage(PrivacyPage);
    expect(container.querySelector('script')).toBeNull();
    expect(container).not.toHaveTextContent("alert('raw html is dropped')");
    // The text of the link stays; the link does not.
    expect(screen.getByText('Опасна връзка').closest('a')).toBeNull();
  });

  it('a text without a `# title` still has a heading: the page’s own name', async () => {
    locale = 'en';
    await renderPage(PrivacyPage);
    expect(screen.getByRole('heading', { level: 1, name: 'Privacy policy' })).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { level: 2, name: 'A test document without its own title' }),
    ).toBeInTheDocument();
  });

  it('the browser title is the text’s own title, and the page has a canonical address', async () => {
    expect(await privacyMetadata()).toEqual({
      title: 'Тестов документ',
      alternates: { canonical: '/privacy' },
    });
  });
});

describe('a legal page whose text is missing', () => {
  it('an empty file counts as missing: a 404', async () => {
    await expect(TermsPage()).rejects.toThrow('NEXT_HTTP_ERROR_FALLBACK;404');
    expect(notFound).toHaveBeenCalled();
  });

  it('no file at all: a 404', async () => {
    await expect(CookiesPage()).rejects.toThrow('NEXT_HTTP_ERROR_FALLBACK;404');
  });

  it('each language on its own: no English terms, no English page', async () => {
    locale = 'en';
    await expect(TermsPage()).rejects.toThrow('NEXT_HTTP_ERROR_FALLBACK;404');
  });
});

describe('LegalDocument', () => {
  it('only the first `# heading` is the h1', () => {
    render(withIntl(<LegalDocument markdown={'# One\n\n# Two\n\ntext'} />));
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getByRole('heading', { level: 2, name: 'Two' })).toBeInTheDocument();
  });

  it('legalTitle reads the first heading, and only a level-one one', () => {
    expect(legalTitle('\n\n# Политика\n\nтекст')).toBe('Политика');
    expect(legalTitle('## Not a title\n\n# Later')).toBeNull();
    expect(legalTitle('just text')).toBeNull();
  });
});
