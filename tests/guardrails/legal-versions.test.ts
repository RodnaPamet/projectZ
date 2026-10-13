import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { LOCALES } from '@/lib/i18n/locales';
import {
  ACCEPTED_DOCUMENTS,
  LEGAL_VERSION_PATTERN,
  parseLegalVersions,
} from '@/lib/legal/versions';

/**
 * THE VERSIONS OF THE TERMS AND THE PRIVACY POLICY (#462).
 *
 * `content/legal-versions.json` says which version of each text is in force.
 * Signed-in people are held at `/start/terms` until they accept it, so each
 * rule below is one way a line in that file locks everybody out or records
 * nothing:
 *
 *   - a version for a text whose file is missing in a language: the step asks
 *     a person to accept a page that answers 404;
 *   - a key or a value the parser drops (a typo, a space, a date with
 *     slashes): the file looks right and nobody is ever asked;
 *   - a Node import in the modules the middleware reads: it runs without one.
 */

const FILE = path.join('content', 'legal-versions.json');

describe('content/legal-versions.json', () => {
  const raw: unknown = JSON.parse(readFileSync(FILE, 'utf8'));

  it('is an object of text → version, and the parser keeps every line of it', () => {
    expect(raw).not.toBeNull();
    expect(typeof raw).toBe('object');
    expect(Array.isArray(raw)).toBe(false);
    const entries = Object.entries(raw as Record<string, unknown>);
    for (const [doc, version] of entries) {
      expect({ doc, known: (ACCEPTED_DOCUMENTS as readonly string[]).includes(doc) }).toEqual({
        doc,
        known: true,
      });
      expect({
        doc,
        wellFormed: typeof version === 'string' && LEGAL_VERSION_PATTERN.test(version),
      }).toEqual({ doc, wellFormed: true });
    }
    expect(Object.keys(parseLegalVersions(raw)).sort()).toEqual(entries.map(([d]) => d).sort());
  });

  it('every text with a version exists, with words in it, in every language', () => {
    const missing: string[] = [];
    for (const doc of Object.keys(parseLegalVersions(raw))) {
      for (const locale of LOCALES) {
        const file = path.join('content', 'legal', locale, `${doc}.md`);
        if (!existsSync(file) || readFileSync(file, 'utf8').trim() === '') missing.push(file);
      }
    }
    if (missing.length > 0) {
      throw new Error(
        `content/legal-versions.json gives a version to a text that is not there:\n\n` +
          missing.map((f) => `  ${f}`).join('\n') +
          `\n\nPeople are asked to accept each text with a version, and cannot accept a\n` +
          `page that answers 404. Add the text in both languages first\n` +
          `(docs/legal-pages.md), or take its line out of the file.`,
      );
    }
  });
});

describe('what the middleware reads has no Node import', () => {
  it.each(['src/lib/legal/versions.ts', 'src/lib/legal/slugs.ts', 'src/lib/auth/owed-step.ts'])(
    '%s',
    (file) => {
      const source = readFileSync(file, 'utf8');
      expect(source).not.toMatch(/from ['"]node:/);
      expect(source).not.toMatch(/from ['"](?:fs|path|crypto)['"]/);
      expect(source).not.toMatch(/from ['"]@\/lib\/(?:db|legal\/texts)/);
      expect(source).not.toMatch(/from ['"]@\/app-layer\//);
    },
  );
});
