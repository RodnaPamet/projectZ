import { nounListValues, nounMessage } from '@/lib/sports/noun-list';

import bg from '../../../messages/bg.json';
import en from '../../../messages/en.json';

/**
 * A list of resource nouns in a sentence (#477), against the real catalogues:
 * each noun's forms, joined as each language joins a list.
 */
type Catalogue = typeof bg;
const words = (m: Catalogue) => (key: string) => {
  const [noun, form] = key.split('.') as [keyof Catalogue['nouns'], 'one' | 'many' | 'counted'];
  return m.nouns[noun][form];
};
const translate =
  (tree: Record<string, unknown>) =>
  (key: string, values: Record<string, string | number> = {}) => {
    const v = key.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown>)?.[k], tree);
    if (typeof v !== 'string') throw new Error(`no ${key}`);
    return v.replace(/\{(\w+)\}/g, (all, n: string) => String(values[n] ?? all));
  };

describe('nounListValues', () => {
  it('Bulgarian: plural and "и", singular and "или", the counted form first, slashes', () => {
    expect(nounListValues(words(bg), 'bg', ['court', 'table', 'seat'])).toEqual({
      Nouns: 'Кортове, маси и места',
      nouns: 'кортове, маси и места',
      AnyNoun: 'Корт, маса или място',
      anyNoun: 'корт, маса или място',
      countedNouns: 'корта, маси и места',
      NounSlash: 'Корт / маса / място',
    });
  });

  it('English: no comma before "and", as the catalogue writes lists', () => {
    expect(
      nounListValues(words(en as unknown as Catalogue), 'en', ['court', 'pitch', 'track']),
    ).toEqual({
      Nouns: 'Courts, pitches and tracks',
      nouns: 'courts, pitches and tracks',
      AnyNoun: 'Court, pitch or track',
      anyNoun: 'court, pitch or track',
      countedNouns: 'courts, pitches and tracks',
      NounSlash: 'Court / pitch / track',
    });
  });

  it('two nouns read without a comma', () => {
    expect(nounListValues(words(bg), 'bg', ['pitch', 'seat']).Nouns).toBe('Игрища и места');
  });
});

describe('nounMessage', () => {
  const t = translate(bg.admin.courts as unknown as Record<string, unknown>);
  it('one noun reads its own wording; the court its plain key', () => {
    expect(nounMessage(t, words(bg), 'bg', 'court', 'title')).toBe('Кортове');
    expect(nounMessage(t, words(bg), 'bg', 'table', 'title')).toBe('Маси');
    expect(nounMessage(t, words(bg), 'bg', 'seat', 'action.add')).toBe('Добавяне на място');
  });

  it('several fill the one `several.` wording, values kept', () => {
    expect(nounMessage(t, words(bg), 'bg', 'courtTable', 'action.add')).toBe(
      'Добавяне на корт или маса',
    );
    expect(
      nounMessage(t, words(bg), 'bg', 'courtPitchTrackTableSeat', 'truncated', { limit: 200 }),
    ).toBe('Показани са първите 200 (кортове, игрища, писти, маси и места). Клубът има повече.');
  });
});
