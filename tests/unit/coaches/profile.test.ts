import {
  canChangeCertificate,
  canEditCoachText,
  COACH_BIO_MAX,
  COACH_BIO_MIN,
  COACH_SLUG_MAX,
  COACH_SPORTS,
  CoachProfileInvalidError,
  coachSlugBase,
  coachSlugCandidate,
  missingForSubmission,
  readCoachProfileInput,
  tidyCoachText,
} from '@/lib/coaches/profile';

/** What a coach's profile may hold and when it can be sent (#377). */

const invalid = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    if (e instanceof CoachProfileInvalidError) return `${e.field}:${e.reason}`;
    throw e;
  }
  return null;
};

describe('reading what a coach typed', () => {
  it('keeps text tidy: line endings, trailing spaces, runs of blank lines; empty is null', () => {
    expect(tidyCoachText('  Тенис от 2010 г.  \r\n\r\n\r\n\r\nВсички нива. \n')).toBe(
      'Тенис от 2010 г.\n\nВсички нива.',
    );
    expect(tidyCoachText('   \n ')).toBeNull();
    expect(tidyCoachText(undefined)).toBeNull();
    expect(tidyCoachText(42)).toBeNull();
  });

  it('takes a full profile and returns the sports in the registry order, whatever order they came in', () => {
    const [first, second] = COACH_SPORTS;
    const read = readCoachProfileInput({
      bio: ' Треньор по тенис. ',
      qualifications: '',
      sports: [
        { sport: second, levelMin: 3, levelMax: 7 },
        { sport: first, levelMin: 1, levelMax: 1 },
      ],
    });
    expect(read).toEqual({
      bio: 'Треньор по тенис.',
      qualifications: null,
      sports: [
        { sport: first, levelMin: 1, levelMax: 1 },
        { sport: second, levelMin: 3, levelMax: 7 },
      ],
    });
  });

  it('an empty profile is a valid thing to save: a draft', () => {
    expect(readCoachProfileInput({})).toEqual({ bio: null, qualifications: null, sports: [] });
  });

  it.each([
    ['a text over the limit', { bio: 'я'.repeat(COACH_BIO_MAX + 1) }, 'bio:TOO_LONG'],
    [
      'qualifications over the limit',
      { qualifications: 'q'.repeat(1001) },
      'qualifications:TOO_LONG',
    ],
    [
      'a sport that takes no level',
      { sports: [{ sport: 'KARTING', levelMin: 1, levelMax: 2 }] },
      'sports:UNKNOWN_SPORT',
    ],
    [
      'a sport that does not exist',
      { sports: [{ sport: 'CURLING', levelMin: 1, levelMax: 2 }] },
      'sports:UNKNOWN_SPORT',
    ],
    ['not an object', { sports: [null] }, 'sports:UNKNOWN_SPORT'],
    [
      'the same sport twice',
      {
        sports: [
          { sport: COACH_SPORTS[0], levelMin: 1, levelMax: 2 },
          { sport: COACH_SPORTS[0], levelMin: 3, levelMax: 4 },
        ],
      },
      'sports:DUPLICATE_SPORT',
    ],
    [
      'levels the wrong way round',
      { sports: [{ sport: COACH_SPORTS[0], levelMin: 5, levelMax: 3 }] },
      'sports:LEVELS',
    ],
    [
      'a level below the scale',
      { sports: [{ sport: COACH_SPORTS[0], levelMin: 0, levelMax: 3 }] },
      'sports:LEVELS',
    ],
    [
      'a level above the scale',
      { sports: [{ sport: COACH_SPORTS[0], levelMin: 1, levelMax: 8 }] },
      'sports:LEVELS',
    ],
    [
      'a level that is not a whole number',
      { sports: [{ sport: COACH_SPORTS[0], levelMin: 1.5, levelMax: 3 }] },
      'sports:LEVELS',
    ],
    [
      'a level as text',
      { sports: [{ sport: COACH_SPORTS[0], levelMin: '1', levelMax: 3 }] },
      'sports:LEVELS',
    ],
  ])('refuses %s', (_l, raw, expected) => {
    expect(invalid(() => readCoachProfileInput(raw))).toBe(expected);
  });

  it('a text exactly at the limit is taken', () => {
    expect(readCoachProfileInput({ bio: 'я'.repeat(COACH_BIO_MAX) }).bio).toHaveLength(
      COACH_BIO_MAX,
    );
  });
});

describe('what a profile needs before it is sent', () => {
  const full = { bio: 'я'.repeat(COACH_BIO_MIN), sports: [{}], hasCertificate: true };

  it('a text, a sport and a certificate; each is named when it is missing', () => {
    expect(missingForSubmission(full)).toEqual([]);
    expect(missingForSubmission({ ...full, bio: 'я'.repeat(COACH_BIO_MIN - 1) })).toEqual(['bio']);
    expect(missingForSubmission({ ...full, bio: null })).toEqual(['bio']);
    expect(missingForSubmission({ ...full, sports: [] })).toEqual(['sports']);
    expect(missingForSubmission({ ...full, hasCertificate: false })).toEqual(['certificate']);
    expect(missingForSubmission({ bio: null, sports: [], hasCertificate: false })).toEqual([
      'bio',
      'sports',
      'certificate',
    ]);
  });
});

describe('what each state lets the coach change', () => {
  it.each([
    ['NONE', true, true],
    ['DRAFT', true, true],
    // What was sent is what gets decided.
    ['SUBMITTED', false, false],
    // The approval was given on this certificate; the text is the coach's.
    ['APPROVED', true, false],
    ['DECLINED', true, true],
  ] as const)('%s: text %s, certificate %s', (state, text, certificate) => {
    expect(canEditCoachText(state)).toBe(text);
    expect(canChangeCertificate(state)).toBe(certificate);
  });
});

describe('the address of a coach page', () => {
  it.each([
    ['Иван Петров', 'ivan-petrov'],
    ['Мария Илиева-Стоянова', 'maria-ilieva-stoyanova'],
    ['Щерю Жечков', 'shteryu-zhechkov'],
    ['Цветан Чочев', 'tsvetan-chochev'],
    ['София', 'sofia'],
    ['Юлия Ъглова', 'yulia-aglova'],
    ['  John   O’Neil  ', 'john-o-neil'],
    ['José Müller', 'jose-muller'],
    ['Ivan 2', 'ivan-2'],
    // One letter that transliterates to two is a slug.
    ['Я', 'ya'],
  ])('%s → %s', (name, slug) => {
    expect(coachSlugBase(name)).toBe(slug);
  });

  it.each([[''], [null], [undefined], ['!!!'], ['а'], ['李'], ['😀😀']])(
    'a name that gives nothing (%s) falls back, and the result is always a valid slug',
    (name) => {
      expect(coachSlugBase(name)).toBe('trenyor');
    },
  );

  it('is never longer than the limit, never ends in a hyphen, and always matches the database’s format', () => {
    const format = /^[a-z0-9][a-z0-9-]{1,63}$/;
    for (const name of [
      'Иван Петров',
      'а'.repeat(200),
      `${'иван'.repeat(11)} ${'петров'.repeat(10)}`,
      'x'.repeat(47) + ' y',
      '',
    ]) {
      const slug = coachSlugBase(name);
      expect(slug.length).toBeLessThanOrEqual(COACH_SLUG_MAX);
      expect(slug).toMatch(format);
      expect(slug.endsWith('-')).toBe(false);
      // With the longest suffix a collision could need, still in format.
      expect(coachSlugCandidate(slug, 999)).toMatch(format);
    }
  });

  it('candidates: the base, then -2, -3', () => {
    expect([1, 2, 3].map((n) => coachSlugCandidate('ivan-petrov', n))).toEqual([
      'ivan-petrov',
      'ivan-petrov-2',
      'ivan-petrov-3',
    ]);
  });
});
