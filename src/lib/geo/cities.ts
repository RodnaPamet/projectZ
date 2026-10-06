/**
 * Bulgarian cities: what a venue's free-text `city` column means (#357, A07).
 *
 * ═══ WHY A MAP AND NOT A LOCALE-AWARE COLUMN ═══
 *
 * `venue.city` is free text a club typed at onboarding, and every pilot row
 * says `Sofia`. Cards printed it as-is with the country code ("Sofia, BG") on
 * a Bulgarian page. Two ways to fix that:
 *
 *   - a column per language (`city_bg`, `city_en`), which is a migration, a
 *     backfill, a second field in every onboarding path and the club form,
 *     and still free text that can disagree with itself;
 *   - this: one small table of the cities a club in Bulgaria can be in,
 *     keyed to a catalogue entry (`cities.<key>` in messages/bg.json and
 *     messages/en.json), with the spellings a club might have typed.
 *
 * The set is small and closed, and the names belong with the rest of the
 * copy, where a translator sees them and the catalogue guards hold them. A
 * city not in the table renders exactly as typed, so a new one degrades to
 * today's behaviour rather than breaking. The column keeps its raw value, so
 * `?city=` and the v1 API (and the native app) are unchanged.
 *
 * ═══ SPELLINGS ARE MATCHING DATA, NOT COPY ═══
 *
 * The lists below include Cyrillic so that a player typing "София" into the
 * search finds venues stored as `Sofia` (and the reverse). They are compared
 * lower-cased and never rendered; what is rendered comes from the catalogue.
 * The first spelling is the canonical one, the value `?city=` carries.
 */
export const CITY_SPELLINGS = {
  sofia: ['Sofia', 'София'],
  plovdiv: ['Plovdiv', 'Пловдив'],
  varna: ['Varna', 'Варна'],
  burgas: ['Burgas', 'Bourgas', 'Бургас'],
  ruse: ['Ruse', 'Rousse', 'Русе'],
  staraZagora: ['Stara Zagora', 'Стара Загора'],
  pleven: ['Pleven', 'Плевен'],
  sliven: ['Sliven', 'Сливен'],
  dobrich: ['Dobrich', 'Добрич'],
  shumen: ['Shumen', 'Шумен'],
  pernik: ['Pernik', 'Перник'],
  haskovo: ['Haskovo', 'Хасково'],
  yambol: ['Yambol', 'Ямбол'],
  pazardzhik: ['Pazardzhik', 'Пазарджик'],
  blagoevgrad: ['Blagoevgrad', 'Благоевград'],
  velikoTarnovo: ['Veliko Tarnovo', 'Veliko Turnovo', 'Велико Търново'],
  vratsa: ['Vratsa', 'Враца'],
  gabrovo: ['Gabrovo', 'Габрово'],
  bansko: ['Bansko', 'Банско'],
  samokov: ['Samokov', 'Самоков'],
} as const satisfies Record<string, readonly [string, ...string[]]>;

export type CityKey = keyof typeof CITY_SPELLINGS;

const norm = (s: string) => s.trim().toLocaleLowerCase('bg');

const BY_SPELLING = new Map<string, CityKey>(
  (Object.entries(CITY_SPELLINGS) as Array<[CityKey, readonly string[]]>).flatMap(([key, names]) =>
    names.map((n) => [norm(n), key] as const),
  ),
);

/** The catalogue key for a stored or typed city, or null for one not in the table. */
export function cityKey(raw: string): CityKey | null {
  return BY_SPELLING.get(norm(raw)) ?? null;
}

/**
 * Every spelling of the city `raw` names, for an exact (case-insensitive)
 * `?city=` filter that finds `Sofia` and `София` rows alike. A city not in
 * the table is itself.
 */
export function citySpellings(raw: string): string[] {
  const key = cityKey(raw);
  return key ? [...CITY_SPELLINGS[key]] : [raw];
}

/**
 * Every spelling of every city with a spelling that contains `q`, for the
 * free-text search: "соф" finds venues stored as `Sofia`. Empty for a query
 * that names no known city, which is the common case (a venue's name).
 */
export function citiesMatching(q: string): string[] {
  const needle = norm(q);
  if (needle.length < 2) return [];
  return (Object.values(CITY_SPELLINGS) as ReadonlyArray<readonly string[]>).flatMap((names) =>
    names.some((n) => norm(n).includes(needle)) ? [...names] : [],
  );
}

/** The canonical spelling of a city — what `?city=` carries — or `raw` unchanged. */
export function canonicalCity(raw: string): string {
  const key = cityKey(raw);
  return key ? CITY_SPELLINGS[key][0] : raw.trim();
}

/**
 * A city's display name: the catalogue's for a known city, else as stored.
 * `t` is a translator for the `cities` namespace (server or client).
 */
export function cityLabel(t: (key: CityKey) => string, raw: string): string {
  const key = cityKey(raw);
  return key ? t(key) : raw;
}
