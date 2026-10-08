import { existsSync, globSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { LEGAL_SLUGS } from '@/lib/legal/texts';
import { LOCALES } from '@/lib/i18n/locales';

/**
 * THE LEGAL PAGES (#370, docs/legal-pages.md).
 *
 * The texts are the owner's, written by the owner or a lawyer. Until one
 * exists its page is a 404 and nothing links to it. Each rule below is one way
 * that quietly breaks:
 *
 *   - a stray file in content/legal (a DOCX dropped in whole, a draft beside the
 *     text) is published by the next deploy, because the image carries the
 *     directory;
 *   - an image without content/ answers 404 on every legal page in production
 *     while every test passes;
 *   - a page that reads its file by hand, not through `loadLegalPage`, renders
 *     an empty page where the 404 belongs;
 *   - a hard-coded `/privacy` anywhere links to a 404 until the text exists;
 *   - `marked` in a client module ships a Markdown parser to every browser for
 *     pages that have no client JS of their own.
 */

const CONTENT = path.join('content', 'legal');
const KEEP = '.gitkeep';
const TEXTS = new Set(LEGAL_SLUGS.map((slug) => `${slug}.md`));

/** Blank block comments and whole-line `//` comments: explaining a rule is allowed. */
function codeOf(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const isClientModule = (source: string) => /^\s*['"]use client['"]/.test(source);

const SOURCES = globSync('src/**/*.{ts,tsx}').map(String);

describe('content/legal holds the texts and nothing else', () => {
  it('one directory per language', () => {
    expect(readdirSync(CONTENT).sort()).toEqual([...LOCALES].sort());
  });

  it.each([...LOCALES])(
    '%s: only privacy.md, terms.md and cookies.md (and a keep-file)',
    (locale) => {
      const stray = readdirSync(path.join(CONTENT, locale)).filter(
        (f) => f !== KEEP && !TEXTS.has(f),
      );
      if (stray.length > 0) {
        throw new Error(
          `content/legal/${locale} holds ${stray.join(', ')}.\n\n` +
            `The image carries content/, so every file here is published. A text is\n` +
            `{privacy,terms,cookies}.md, converted with pandoc (docs/legal-pages.md).`,
        );
      }
    },
  );

  it('the runner image carries content/, or every legal page is a 404 in production', () => {
    expect(readFileSync('Dockerfile', 'utf8')).toMatch(
      /^COPY --from=builder [^\n]*\/app\/content \.\/content$/m,
    );
  });
});

describe('the pages', () => {
  it.each([...LEGAL_SLUGS])('/%s reads its text through loadLegalPage, on the server', (slug) => {
    const file = path.join('src', 'app', '(public)', slug, 'page.tsx');
    expect(existsSync(file)).toBe(true);
    const source = readFileSync(file, 'utf8');
    expect(isClientModule(source)).toBe(false);
    expect(codeOf(source)).toMatch(new RegExp(`loadLegalPage\\('${slug}'\\)`));
    expect(codeOf(source)).toMatch(new RegExp(`legalMetadata\\('${slug}'\\)`));
  });

  it('the renderer is server-only: no client module imports marked, or the legal code', () => {
    const offenders = SOURCES.filter((f) => {
      const source = readFileSync(f, 'utf8');
      return (
        isClientModule(source) &&
        /from ['"](?:marked|@\/lib\/legal\/[^'"]+|@\/components\/legal\/[^'"]+)['"]/.test(source)
      );
    });
    expect(offenders).toEqual([]);
    for (const f of globSync('src/{lib,components}/legal/**/*.{ts,tsx}').map(String)) {
      expect(isClientModule(readFileSync(f, 'utf8'))).toBe(false);
    }
  });

  it('marked is imported in one place, the renderer', () => {
    const importers = SOURCES.filter((f) => /from ['"]marked['"]/.test(readFileSync(f, 'utf8')));
    expect(importers).toEqual(['src/components/legal/LegalDocument.tsx']);
  });
});

describe('every link to a legal page asks whether its text exists', () => {
  // A quoted path to a legal page: '/privacy', "/terms", `/cookies`, with or
  // without a fragment or a query after it.
  const HREF = new RegExp(`['"\`]/(?:${LEGAL_SLUGS.join('|')})(?=['"\`#?])`);

  it('no file but src/lib/legal/texts.ts spells one out', () => {
    const offenders = SOURCES.filter(
      (f) => f !== 'src/lib/legal/texts.ts' && HREF.test(codeOf(readFileSync(f, 'utf8'))),
    );
    if (offenders.length > 0) {
      throw new Error(
        `A legal page's path, spelled out in:\n\n${offenders.map((f) => `  ${f}`).join('\n')}\n\n` +
          `Until the owner's text exists the page is a 404. Take the href from\n` +
          `legalHrefs(locale) (src/lib/legal/texts.ts), which is null until then.`,
      );
    }
  });

  it('the scan sees the files that link them', () => {
    for (const f of [
      'src/components/layout/site-footer.tsx',
      'src/app/(home)/page.tsx',
      'src/app/(app)/start/kind/page.tsx',
      'src/app/(public)/me/profile/page.tsx',
      'src/components/layout/player-chrome.tsx',
    ]) {
      expect(SOURCES).toContain(f);
      expect(readFileSync(f, 'utf8')).toMatch(/legalHrefs\(/);
    }
  });
});
