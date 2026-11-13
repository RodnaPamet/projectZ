import { globSync, readFileSync } from 'node:fs';

import { factsProblems } from '@/lib/sports/facts';

/**
 * EVERY SPORT'S FACTS FILE KEEPS THE RULES (owner 2026-11-13).
 *
 * The owner writes the facts (src/content/sport-facts/<SPORT>.json) and the
 * loader quietly leaves out a file that breaks a rule, so a sport would just
 * lose its fact of the week on the phone. This fails the build first, naming
 * the file and what is wrong:
 *
 *   - the file is named for a sport key, and its "sport" says the same;
 *   - exactly 52 facts, each with Bulgarian, English and an https source;
 *   - no Bulgarian text matches /[ыэё]|ь(?!о)/ (Russian letters, owner
 *     2026-10-31).
 *
 * The rules themselves live in `factsProblems`, the loader's own check, so
 * the build and the running app cannot disagree about a file.
 */

const FILES = globSync('src/content/sport-facts/*.json')
  .map((f) => f.toString())
  .sort();

const FIXTURE = 'tests/fixtures/sport-facts/TENNIS.json';

describe('sport facts', () => {
  it('the rules catch a broken file, so passing on the real ones means something', () => {
    const good = JSON.parse(readFileSync(FIXTURE, 'utf8'));
    expect(factsProblems(good, 'TENNIS')).toEqual([]);
    expect(factsProblems({ ...good, facts: good.facts.slice(0, 51) }, 'TENNIS')).not.toEqual([]);
    expect(factsProblems(good, 'PADEL')).not.toEqual([]);
  });

  it.each(FILES.length > 0 ? FILES.map((f) => [f]) : [['(none yet)']])(
    '%s keeps the rules',
    (file) => {
      if (file === '(none yet)') return;
      const sport = file.replace(/^.*\//, '').replace(/\.json$/, '');
      let raw: unknown;
      try {
        raw = JSON.parse(readFileSync(file, 'utf8'));
      } catch (err) {
        throw new Error(`${file} is not valid JSON: ${(err as Error).message}`);
      }
      expect({ file, problems: factsProblems(raw, sport) }).toEqual({ file, problems: [] });
    },
  );

  it('the image carries the directory the loader reads', () => {
    // Without this COPY every fact is a 404 in production and no fact is
    // pushed, while every test here passes.
    expect(readFileSync('Dockerfile', 'utf8')).toMatch(
      /^COPY --from=builder --chown=nextjs:nodejs \/app\/src\/content \.\/src\/content$/m,
    );
  });
});
