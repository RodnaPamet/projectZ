/**
 * @jest-environment node
 */
import path from 'node:path';

import {
  LEGAL_HREF,
  legalContentRoot,
  legalHrefs,
  legalTextPath,
  readLegalText,
} from '@/lib/legal/texts';

/**
 * Which legal texts exist (#370): a file with words in it, in the page's
 * language. What every link to a legal page is drawn from.
 */
const FIXTURES = path.join(process.cwd(), 'tests', 'fixtures', 'legal');

describe('the legal texts on disk', () => {
  const previous = process.env.LEGAL_CONTENT_DIR;
  afterEach(() => {
    if (previous === undefined) delete process.env.LEGAL_CONTENT_DIR;
    else process.env.LEGAL_CONTENT_DIR = previous;
  });

  it('live in content/legal/{locale}/{slug}.md, unless a test points elsewhere', () => {
    delete process.env.LEGAL_CONTENT_DIR;
    expect(legalContentRoot()).toBe(path.join(process.cwd(), 'content', 'legal'));
    expect(legalTextPath('cookies', 'en')).toBe(
      path.join(process.cwd(), 'content', 'legal', 'en', 'cookies.md'),
    );
  });

  it('a file with words is a text; an empty one and a missing one are not', async () => {
    process.env.LEGAL_CONTENT_DIR = FIXTURES;
    expect(await readLegalText('privacy', 'bg')).toContain('# Тестов документ');
    expect(await readLegalText('terms', 'bg')).toBeNull();
    expect(await readLegalText('cookies', 'bg')).toBeNull();
  });

  it('legalHrefs links only what exists, language by language', async () => {
    process.env.LEGAL_CONTENT_DIR = FIXTURES;
    expect(await legalHrefs('bg')).toEqual({ privacy: '/privacy', terms: null, cookies: null });
    expect(await legalHrefs('en')).toEqual({ privacy: '/privacy', terms: null, cookies: null });
  });

  it('the pages are where the links say', () => {
    expect(LEGAL_HREF).toEqual({ privacy: '/privacy', terms: '/terms', cookies: '/cookies' });
  });
});
