import type { SportType } from '@prisma/client';

import { MAX_SPORT_LEVEL, MIN_SPORT_LEVEL } from '@/lib/profile/limits';

/**
 * «ВЗЕМИ НАЧАЛНО НИВО»: THE STARTING-LEVEL QUESTIONNAIRE (#689).
 *
 * Owner 2026-11-13: a new player gets a starting rating from a few questions
 * per sport, as Courtly's «Get your starting rating» does. The wording, the
 * level each answer suggests and the cap below were APPROVED BY THE OWNER as
 * drafted on #689; change them there first.
 *
 * Each answer suggests a level on the 1–7 scale. The starting level is the
 * average of the answers, rounded, and an answer marked `beginnerCap` ("just
 * starting") holds it at 2 at most. It sets only the DECLARED level a rating
 * is seeded from (`seedRating` in levels.ts): matches move it from there.
 */

export interface SurveyText {
  bg: string;
  en: string;
}

export interface SurveyOption {
  id: string;
  text: SurveyText;
  /** The level this answer suggests, 1–7. */
  level: number;
  /** "Just starting": the result is 2 at most. */
  beginnerCap?: boolean;
}

export interface SurveyQuestion {
  id: string;
  text: SurveyText;
  options: SurveyOption[];
}

/** The most a beginner's answers can come to. */
export const BEGINNER_CAP = 2;

const t = (bg: string, en: string): SurveyText => ({ bg, en });
const o = (
  id: string,
  bg: string,
  en: string,
  level: number,
  beginnerCap = false,
): SurveyOption => ({
  id,
  text: t(bg, en),
  level,
  ...(beginnerCap ? { beginnerCap } : {}),
});

const howLong = (sport: SurveyText): SurveyQuestion => ({
  id: 'experience',
  text: sport,
  options: [
    o('starting', 'Започвам сега', 'Just starting', 1, true),
    o('under6m', 'До 6 месеца', 'Under 6 months', 2),
    o('to2y', 'От 6 месеца до 2 години', '6 months to 2 years', 3),
    o('to5y', '2–5 години', '2–5 years', 5),
    o('over5y', 'Над 5 години', 'Over 5 years', 6),
  ],
});

const howOften: SurveyQuestion = {
  id: 'frequency',
  text: t('Колко често играете?', 'How often do you play?'),
  options: [
    o('yearly', 'Няколко пъти в годината', 'A few times a year', 1),
    o('monthly', '1–2 пъти в месеца', '1–2 times a month', 2),
    o('weekly', 'Всяка седмица', 'Every week', 4),
    o('twiceWeekly', '2 или повече пъти седмично', 'Twice a week or more', 5),
    o(
      'coached',
      'Тренирам с треньор и играя мачове редовно',
      'I train with a coach and play matches regularly',
      6,
    ),
  ],
};

const PADEL: SurveyQuestion[] = [
  howLong(t('Откога играете падел?', 'How long have you played padel?')),
  howOften,
  {
    id: 'otherRacket',
    text: t('Друг ракетен спорт?', 'Another racket sport?'),
    options: [
      o('no', 'Не', 'No', 1),
      o('fun', 'За удоволствие', 'For fun', 2),
      o('years', 'Години наред, редовно', 'Regularly, for years', 4),
      o('competitive', 'Състезателно', 'Competitively', 5),
    ],
  },
  {
    id: 'serve',
    text: t('Сервис и връщане', 'Serve and return'),
    options: [
      o('learning', 'Още уча сервиса', 'Still learning to serve', 1),
      o(
        'safe',
        'Сервирам сигурно, връщам лесните топки',
        'A safe serve; I return the easy balls',
        3,
      ),
      o(
        'placed',
        'Насочвам сервиса, връщам почти всичко',
        'I place my serve and return almost everything',
        5,
      ),
      o('spin', 'Сервис с ефект, атакуващо връщане', 'Serve with spin, attacking return', 7),
    ],
  },
  {
    id: 'glass',
    text: t('Топки от стъклото', 'Balls off the glass'),
    options: [
      o('avoid', 'Избягвам ги', 'I avoid them', 1),
      o(
        'back',
        'Връщам по-лесните от задното стъкло',
        'I return the easier ones off the back glass',
        3,
      ),
      o(
        'confident',
        'Играя уверено от задно и странично стъкло',
        'Confident off the back and side glass',
        5,
      ),
      o(
        'tactical',
        'Използвам стъклата тактически, вкл. двойно стъкло',
        'I use the glass tactically, double glass included',
        7,
      ),
    ],
  },
  {
    id: 'net',
    text: t('Воле и игра на мрежата', 'Volleys and net play'),
    options: [
      o('rarely', 'Рядко съм на мрежата', 'Rarely at the net', 1),
      o('slow', 'Воле при бавни топки', 'Volleys on slow balls', 3),
      o('bandeja', 'Сигурно воле и бандеха', 'Solid volleys and a bandeja', 5),
      o(
        'vibora',
        'Вибора, смяна на ритъма, затварям мрежата',
        'Víbora, changes of pace, I close the net',
        7,
      ),
    ],
  },
  {
    id: 'smash',
    text: t('Смач', 'Smash'),
    options: [
      o('none', 'Още не смачвам', "I don't smash yet", 1),
      o('easy', 'Смач при лесни топки', 'Smash on easy balls', 3),
      o(
        'placed',
        'Насочен смач, понякога извън корта',
        'A placed smash, sometimes out of the court',
        5,
      ),
      o('porTres', 'Смач «по 3» и «по 4» нарочно', '«Por tres» and «por cuatro» on purpose', 7),
    ],
  },
  {
    id: 'tactics',
    text: t('Тактика', 'Tactics'),
    options: [
      o('ballByBall', 'Играя топка по топка', 'Ball by ball', 1),
      o('lob', 'Лобирам, за да изляза от натиск', 'I lob to get out of pressure', 3),
      o(
        'pair',
        'Строим точката с партньора, лоб за мрежата',
        'We build points as a pair; a lob to take the net',
        5,
      ),
      o(
        'read',
        'Чета противниците и сменям плана по време на мача',
        'I read opponents and change plans mid-match',
        7,
      ),
    ],
  },
  {
    id: 'tournaments',
    text: t('Турнири', 'Tournaments'),
    options: [
      o('never', 'Не съм играл/а', 'Never', 2),
      o('americano', 'Американо, приятелски турнири', 'Americanos, friendly tournaments', 3),
      o('club', 'Клубни и местни турнири', 'Club and local tournaments', 5),
      o(
        'national',
        'Национална ранглиста или международни',
        'National ranking or international',
        7,
      ),
    ],
  },
];

const TENNIS: SurveyQuestion[] = [
  howLong(t('Откога играете тенис?', 'How long have you played tennis?')),
  howOften,
  {
    id: 'groundstrokes',
    text: t('Форхенд и бекхенд', 'Forehand and backhand'),
    options: [
      o('hit', 'Удрям топката, но рядко я насочвам', 'I hit it, rarely where I want', 1),
      o(
        'forehand',
        'Сигурен форхенд, бекхендът е по-слаб',
        'Reliable forehand, weaker backhand',
        3,
      ),
      o(
        'both',
        'И двата са сигурни, с насока и дълбочина',
        'Both reliable, with direction and depth',
        5,
      ),
      o(
        'attack',
        'Атакувам и от двете страни, с ефект по избор',
        'I attack off both sides, spin as I choose',
        7,
      ),
    ],
  },
  {
    id: 'serve',
    text: t('Сервис', 'Serve'),
    options: [
      o('learning', 'Още уча сервиса', 'Still learning it', 1),
      o('safe', 'Сигурен първи сервис, без сила', 'A safe first serve, no pace', 3),
      o('placed', 'Насочвам първия, сигурен втори', 'A placed first serve, a reliable second', 5),
      o(
        'weapon',
        'Сила и ефект, печеля точки от сервиса',
        'Pace and spin; I win points off my serve',
        7,
      ),
    ],
  },
  {
    id: 'rally',
    text: t('Разменяне от основната линия', 'Rallying from the baseline'),
    options: [
      o('short', 'Няколко удара и грешка', 'A few shots, then an error', 1),
      o('moderate', '6–10 удара при умерено темпо', '6–10 shots at a moderate pace', 3),
      o('long', 'Дълги разменяния, сменям посоката', 'Long rallies; I change direction', 5),
      o(
        'control',
        'Контролирам темпото и строя точката',
        'I control the pace and build the point',
        7,
      ),
    ],
  },
  {
    id: 'net',
    text: t('Воле и мрежа', 'Volleys and net'),
    options: [
      o('rarely', 'Рядко съм на мрежата', 'Rarely at the net', 1),
      o('easy', 'Воле при лесни топки', 'Volleys on easy balls', 3),
      o('approach', 'Излизам на мрежата след подготвящ удар', 'I come in behind an approach', 5),
      o('serveVolley', 'Сервис-воле и полуволе', 'Serve-and-volley and half-volleys', 7),
    ],
  },
  {
    id: 'tactics',
    text: t('Тактика', 'Tactics'),
    options: [
      o('over', 'Връщам топката през мрежата', 'I get it back over', 1),
      o(
        'weakSide',
        'Играя на слабата страна на противника',
        "I play to the opponent's weak side",
        3,
      ),
      o('build', 'Строя точката, сменям ритъма', 'I build points and change the rhythm', 5),
      o(
        'plan',
        'Имам план и го сменям по време на мача',
        'I have a plan and change it mid-match',
        7,
      ),
    ],
  },
  {
    id: 'tournaments',
    text: t('Турнири', 'Tournaments'),
    options: [
      o('never', 'Не съм играл/а', 'Never', 2),
      o('amateur', 'Приятелски и любителски турнири', 'Friendly and amateur tournaments', 3),
      o(
        'club',
        'Клубни и местни турнири, любителски ранглисти',
        'Club and local tournaments, amateur rankings',
        5,
      ),
      o(
        'federation',
        'БФТ ранглиста, ITF или по-високо',
        'Bulgarian Tennis Federation ranking, ITF or higher',
        7,
      ),
    ],
  },
];

// The enum's order: tennis before padel.
const SURVEYS: Partial<Record<SportType, SurveyQuestion[]>> = { TENNIS, PADEL };

/** The sports with a questionnaire, in the enum's order. */
export const SURVEY_SPORTS = Object.keys(SURVEYS) as SportType[];

/** The questions for `sport`, or null where there is none. */
export function surveyFor(sport: SportType): SurveyQuestion[] | null {
  return SURVEYS[sport] ?? null;
}

/**
 * The starting level the answers come to: the average of the levels they
 * suggest, rounded, at most 2 for a beginner. Null unless every question has
 * one known answer.
 */
export function scoreSurvey(sport: SportType, answers: Record<string, string>): number | null {
  const questions = surveyFor(sport);
  if (!questions) return null;
  const picked: SurveyOption[] = [];
  for (const q of questions) {
    const option = q.options.find((opt) => opt.id === answers[q.id]);
    if (!option) return null;
    picked.push(option);
  }
  if (Object.keys(answers).length !== questions.length) return null;
  const average = picked.reduce((sum, p) => sum + p.level, 0) / picked.length;
  let level = Math.round(average);
  if (picked.some((p) => p.beginnerCap)) level = Math.min(level, BEGINNER_CAP);
  return Math.min(MAX_SPORT_LEVEL, Math.max(MIN_SPORT_LEVEL, level));
}
