import { globSync, readFileSync } from 'node:fs';

import { storyProblems } from '@/lib/sports/stories';

/**
 * EVERY SPORT STORY KEEPS THE RULES (owner 2026-11-13).
 *
 * The owner writes the stories (src/content/sport-stories/<SPORT>.json) and
 * the loader quietly leaves out a file that breaks a rule, so a sport would
 * just lose its story on the phone. This fails the build first, naming the
 * file and what is wrong:
 *
 *   - the file is named for a sport key, and its "sport" says the same;
 *   - two history paragraphs per language, three sentences each at most;
 *   - exactly 52 facts, each with Bulgarian, English and an https source;
 *   - no Bulgarian text matches /[ыэё]|ь(?!о)/ (Russian letters, owner
 *     2026-10-31).
 *
 * The rules themselves live in `storyProblems`, the loader's own check, so
 * the build and the running app cannot disagree about a file.
 */

const FILES = globSync('src/content/sport-stories/*.json')
  .map((f) => f.toString())
  .sort();

const FIXTURE = 'tests/fixtures/sport-stories/TENNIS.json';

describe('sport stories', () => {
  it('the rules catch a broken file, so passing on the real ones means something', () => {
    const good = JSON.parse(readFileSync(FIXTURE, 'utf8'));
    expect(storyProblems(good, 'TENNIS')).toEqual([]);
    expect(storyProblems({ ...good, facts: good.facts.slice(0, 51) }, 'TENNIS')).not.toEqual([]);
    expect(storyProblems(good, 'PADEL')).not.toEqual([]);
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
      expect({ file, problems: storyProblems(raw, sport) }).toEqual({ file, problems: [] });
    },
  );

  it('the image carries the directory the loader reads', () => {
    // Without this COPY every story is a 404 in production and no fact is
    // pushed, while every test here passes.
    expect(readFileSync('Dockerfile', 'utf8')).toMatch(
      /^COPY --from=builder --chown=nextjs:nodejs \/app\/src\/content \.\/src\/content$/m,
    );
  });
});
