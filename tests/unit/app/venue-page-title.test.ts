/**
 * @jest-environment node
 */
import {
  bookingNoun,
  RESOURCE_KINDS,
  RESOURCE_TYPES,
  type BookingNoun,
} from '@/lib/sports/resource-kinds';

import bg from '../../../messages/bg.json';
import en from '../../../messages/en.json';

/**
 * THE VENUE PAGE'S TITLE SAYS WHAT THE VENUE OFFERS (#362).
 *
 * The title was "{name} — резервирай корт" whatever the venue had, so a
 * karting track's search result offered a court, and so did a football
 * venue's. It now takes its word from the venue's bookable resources through
 * the resource-kinds table (`bookingNoun`): a track, a pitch ("игрище"), a
 * court, or a time ("час") where no one word is true: a mix, or a kind with
 * no word of its own in the title (a table, a lobby, a climbing route).
 */

type Locale = 'bg' | 'en';
const CATALOGUES = { bg, en } as const;
let locale: Locale = 'bg';
let resources: Array<{ resourceType: string }> = [];

jest.mock('@/lib/db/rls-middleware', () => ({
  runAsSuperuser: (fn: (db: unknown) => unknown) =>
    Promise.resolve(fn({ venueOrg: { findUnique: async () => ({ slug: 'sofia-karting-ring' }) } })),
}));

jest.mock('@/app-layer/repositories/venue', () => ({
  getVenueByPublicSlug: async (_db: unknown, publicSlug: string) => ({
    id: 'v1',
    tenantId: 't1',
    publicSlug,
    name: 'Sofia Ring',
    description: null,
    addressLine: 'Sofia Ring Mall',
    city: 'Sofia',
    country: 'BG',
    coverPhotoUrl: null,
    photos: [],
    amenities: [],
    resources,
  }),
}));

jest.mock('@/app-layer/usecases/venue-availability', () => ({ loadVenueAvailability: jest.fn() }));
jest.mock('@/components/layout/player-chrome', () => ({ playerChrome: jest.fn() }));

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

async function titleFor(types: string[], lang: Locale = 'bg') {
  locale = lang;
  resources = types.map((resourceType) => ({ resourceType }));
  const { generateMetadata } = await import('@/app/(public)/venues/[slug]/page');
  const meta = await generateMetadata({ params: Promise.resolve({ slug: 'sofia-karting-ring' }) });
  return { title: meta.title, og: (meta.openGraph as { title?: string } | undefined)?.title };
}

describe('the venue page’s title', () => {
  it.each([
    [['TRACK'], 'Sofia Ring — резервирай писта | playerz.bg'],
    [['TRACK', 'TRACK'], 'Sofia Ring — резервирай писта | playerz.bg'],
    [['FIELD'], 'Sofia Ring — резервирай игрище | playerz.bg'],
    [['COURT', 'COURT'], 'Sofia Ring — резервирай корт | playerz.bg'],
    [['COURT', 'TRACK'], 'Sofia Ring — резервирай час | playerz.bg'],
    [['COURT', 'FIELD'], 'Sofia Ring — резервирай час | playerz.bg'],
    [['TABLE'], 'Sofia Ring — резервирай час | playerz.bg'],
    [[], 'Sofia Ring — резервирай корт | playerz.bg'],
  ])('resources %j: "%s"', async (types, expected) => {
    const { title, og } = await titleFor(types);
    expect(title).toBe(expected);
    expect(og).toBe(expected);
  });

  it.each([
    [['TRACK'], 'Sofia Ring — book a track | playerz.bg'],
    [['FIELD'], 'Sofia Ring — book a pitch | playerz.bg'],
    [['COURT'], 'Sofia Ring — book a court | playerz.bg'],
    [['COURT', 'TRACK'], 'Sofia Ring — book a time | playerz.bg'],
  ])('in English, resources %j: "%s"', async (types, expected) => {
    expect((await titleFor(types, 'en')).title).toBe(expected);
  });
});

describe('bookingNoun, the table’s rule', () => {
  it('one word per kind, a time for a mix, a court for none or an unknown type', () => {
    expect(bookingNoun(['TRACK'])).toBe('track');
    expect(bookingNoun(['FIELD', 'FIELD'])).toBe('field');
    expect(bookingNoun(['COURT'])).toBe('court');
    expect(bookingNoun(['COURT', 'TRACK'])).toBe('time');
    expect(bookingNoun(['TABLE', 'BOARD_TABLE'])).toBe('time');
    expect(bookingNoun([])).toBe('court');
    expect(bookingNoun(['HOVERCRAFT_PAD'])).toBe('court');
  });

  it('every booking word has its title in both catalogues', () => {
    const nouns = new Set<BookingNoun>(RESOURCE_TYPES.map((t) => RESOURCE_KINDS[t].booking));
    for (const noun of nouns) {
      const key = noun === 'court' ? 'venue.metaTitle' : `venue.${noun}.metaTitle`;
      for (const messages of [bg, en]) {
        expect({ key, value: typeof lookup(messages, key) }).toEqual({ key, value: 'string' });
      }
    }
  });
});
