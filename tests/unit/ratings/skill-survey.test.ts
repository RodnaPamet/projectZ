import { BEGINNER_CAP, SURVEY_SPORTS, scoreSurvey, surveyFor } from '@/lib/ratings/skill-survey';

/** «Вземи начално ниво» (#689): the owner-approved questions and their scoring. */
describe('the starting-level questionnaire', () => {
  const answering = (sport: 'PADEL' | 'TENNIS', pick: (levels: number[]) => number) =>
    Object.fromEntries(
      surveyFor(sport)!.map((q) => {
        const levels = q.options.map((o) => o.level);
        const want = pick(levels);
        return [q.id, q.options.find((o) => o.level === want)!.id];
      }),
    );

  it('padel and tennis, in the enum’s order; nothing else yet', () => {
    expect(SURVEY_SPORTS).toEqual(['TENNIS', 'PADEL']);
    expect(surveyFor('PADEL')).toHaveLength(9);
    expect(surveyFor('TENNIS')).toHaveLength(8);
    expect(surveyFor('CHESS')).toBeNull();
  });

  it('every question and answer has both languages, unique ids, and a level 1–7', () => {
    for (const sport of SURVEY_SPORTS) {
      const qs = surveyFor(sport)!;
      expect(new Set(qs.map((q) => q.id)).size).toBe(qs.length);
      for (const q of qs) {
        expect(q.text.bg).toMatch(/[а-я]/i);
        expect(q.text.en).toMatch(/[a-z]/i);
        expect(new Set(q.options.map((o) => o.id)).size).toBe(q.options.length);
        for (const o of q.options) {
          expect(o.level).toBeGreaterThanOrEqual(1);
          expect(o.level).toBeLessThanOrEqual(7);
          expect(o.text.bg.length).toBeGreaterThan(0);
          expect(o.text.en.length).toBeGreaterThan(0);
        }
      }
    }
  });

  it('the average of the suggested levels, rounded', () => {
    // Highest everywhere: experience and frequency top out at 6, another
    // racket sport at 5, the rest at 7.
    const top = scoreSurvey(
      'PADEL',
      answering('PADEL', (l) => Math.max(...l)),
    );
    expect(top).toBe(Math.round((6 + 6 + 5 + 7 * 6) / 9));
    expect(
      scoreSurvey(
        'TENNIS',
        answering('TENNIS', (l) => Math.min(...l)),
      ),
    ).toBe(Math.round((1 + 1 + 1 + 1 + 1 + 1 + 1 + 2) / 8));
  });

  it('a beginner starts at 2 at most, whatever else they answer', () => {
    const answers = answering('TENNIS', (l) => Math.max(...l));
    answers.experience = 'starting';
    expect(scoreSurvey('TENNIS', answers)).toBe(BEGINNER_CAP);
  });

  it('every question answered once, with a known answer, or no level', () => {
    const answers = answering('PADEL', (l) => l[1]!);
    expect(scoreSurvey('PADEL', answers)).not.toBeNull();
    const { smash: _smash, ...missing } = answers;
    expect(scoreSurvey('PADEL', missing)).toBeNull();
    expect(scoreSurvey('PADEL', { ...answers, smash: 'nosuch' })).toBeNull();
    expect(scoreSurvey('PADEL', { ...answers, extra: 'x' })).toBeNull();
    expect(scoreSurvey('CHESS', answers)).toBeNull();
  });
});
