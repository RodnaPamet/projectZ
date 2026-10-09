/**
 * @jest-environment node
 */
import bg from '../../../messages/bg.json';
import en from '../../../messages/en.json';

/**
 * THE CLUB PAGE'S TITLE SAYS WHAT THE CLUB OFFERS (#454).
 *
 * `/clubs/{slug}` read "{name} — кортове и резервации" whatever the club had,
 * so a football club's search result offered courts. It now follows the venue
 * title's rule (`bookingNoun`, venue-page-title.test.ts) over every venue the
 * club shows: pitches, tracks, courts, or free times where no one word is
 * true of them.
 */

type Locale = 'bg' | 'en';
const CATALOGUES = { bg, en } as const;
let locale: Locale = 'bg';
let venues: Array<{ resourceTypes: string[] }> = [];

jest.mock('@/lib/db/rls-middleware', () => ({
  runAsSuperuser: (fn: (db: unknown) => unknown) => Promise.resolve(fn({})),
}));

jest.mock('@/app-layer/usecases/club-public-page', () => ({
  loadClubPublicPage: async (_db: unknown, slug: string) => ({
    id: 'c1',
    slug,
    name: 'Спортна София',
    logoUrl: null,
    phone: null,
    cover: null,
    venues: venues.map((v, i) => ({
      id: `v${i}`,
      publicSlug: `v${i}`,
      name: `Обект ${i}`,
      addressLine: 'ул. Тестова 1',
      city: 'Sofia',
      country: 'BG',
      timezone: 'Europe/Sofia',
      phone: null,
      sports: [],
      cover: null,
      ...v,
    })),
  }),
}));

jest.mock('@/app-layer/usecases/venue-availability', () => ({ loadVenueAvailability: jest.fn() }));
jest.mock('@/components/layout/player-chrome-data', () => ({ chromeIdentity: jest.fn() }));

/** The real catalogue, as next-intl reads it: a dotted key is a nested one. */
function lookup(messages: unknown, key: string): unknown {
  return key
    .split('.')
    .reduce<unknown>((m, k) => (m as Record<string, unknown> | undefined)?.[k], messages);
}
jest.mock('next-intl/server', () => ({
  getLocale: async () => locale,
  getTranslations:
    async (ns: string) =>
    (key: string, values: Record<string, string> = {}) => {
      const value = lookup(CATALOGUES[locale], `${ns}.${key}`);
      if (typeof value !== 'string') return `${ns}.${key}`;
      return Object.entries(values).reduce((s, [k, v]) => s.replace(`{${k}}`, v), value);
    },
}));

async function titleFor(perVenue: string[][], lang: Locale = 'bg') {
  locale = lang;
  venues = perVenue.map((resourceTypes) => ({ resourceTypes }));
  const { generateMetadata } = await import('@/app/(public)/clubs/[slug]/page');
  const meta = await generateMetadata({ params: Promise.resolve({ slug: 'sportna-sofia' }) });
  return { title: meta.title, og: (meta.openGraph as { title?: string } | undefined)?.title };
}

describe('the club page’s title', () => {
  it.each([
    [[['FIELD', 'FIELD']], 'Спортна София — игрища и резервации | playerz.bg'],
    [[['FIELD'], ['FIELD']], 'Спортна София — игрища и резервации | playerz.bg'],
    [[['TRACK']], 'Спортна София — писти и резервации | playerz.bg'],
    [[['COURT']], 'Спортна София — кортове и резервации | playerz.bg'],
    // A court at one venue and a pitch at another: no one word is true.
    [[['COURT'], ['FIELD']], 'Спортна София — свободни часове и резервации | playerz.bg'],
    [[['TABLE']], 'Спортна София — свободни часове и резервации | playerz.bg'],
    [[], 'Спортна София — кортове и резервации | playerz.bg'],
  ])('venues %j: "%s"', async (perVenue, expected) => {
    const { title, og } = await titleFor(perVenue);
    expect(title).toBe(expected);
    expect(og).toBe(expected);
  });

  it.each([
    [[['FIELD']], 'Спортна София — pitches and booking | playerz.bg'],
    [[['TRACK']], 'Спортна София — tracks and booking | playerz.bg'],
    [[['COURT']], 'Спортна София — courts and booking | playerz.bg'],
    [[['COURT', 'TRACK']], 'Спортна София — free slots and booking | playerz.bg'],
  ])('in English, venues %j: "%s"', async (perVenue, expected) => {
    expect((await titleFor(perVenue, 'en')).title).toBe(expected);
  });
});
