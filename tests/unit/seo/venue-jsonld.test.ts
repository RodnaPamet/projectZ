import {
  buildVenueJsonLd,
  hourlyPriceRange,
  serializeJsonLd,
  type VenueJsonLdInput,
} from '@/lib/seo/venue-jsonld';

/**
 * The venue page's JSON-LD (#396), checked against schema.org's shapes.
 *
 * SHAPES is the slice of schema.org this emits: for each type, the
 * properties schema.org defines on it (own or inherited) that may appear, and
 * which are required for the result to mean anything. A property outside the
 * list is either a typo or a property of another type — both of which search
 * engines silently drop, so they fail here instead.
 *
 * SportsActivityLocation inherits from LocalBusiness, Organization and Place
 * (and Thing): `address`, `geo`, `telephone`, `amenityFeature` are Place's,
 * `priceRange` LocalBusiness's, `name`/`description`/`url`/`image` Thing's.
 * https://schema.org/SportsActivityLocation
 */
const SHAPES: Record<string, { required: string[]; allowed: string[] }> = {
  SportsActivityLocation: {
    required: ['name', 'address', 'url'],
    allowed: [
      '@context',
      '@type',
      '@id',
      'name',
      'description',
      'url',
      'image',
      'address',
      'geo',
      'telephone',
      'priceRange',
      'amenityFeature',
    ],
  },
  PostalAddress: {
    required: ['streetAddress', 'addressLocality', 'addressCountry'],
    allowed: [
      '@type',
      'streetAddress',
      'addressLocality',
      'addressRegion',
      'postalCode',
      'addressCountry',
    ],
  },
  GeoCoordinates: {
    required: ['latitude', 'longitude'],
    allowed: ['@type', 'latitude', 'longitude'],
  },
  LocationFeatureSpecification: {
    required: ['name', 'value'],
    allowed: ['@type', 'name', 'value'],
  },
};

/** Every node in the tree matches its type's shape. Returns the problems found. */
function validate(node: unknown, path = '$'): string[] {
  if (Array.isArray(node)) return node.flatMap((n, i) => validate(n, `${path}[${i}]`));
  if (!node || typeof node !== 'object') return [];
  const obj = node as Record<string, unknown>;
  const type = obj['@type'];
  if (typeof type !== 'string') return [`${path}: object without @type`];
  const shape = SHAPES[type];
  if (!shape) return [`${path}: unexpected type ${type}`];
  const problems: string[] = [];
  for (const key of shape.required) {
    if (obj[key] === undefined || obj[key] === '') problems.push(`${path}: ${type} needs ${key}`);
  }
  for (const key of Object.keys(obj)) {
    if (!shape.allowed.includes(key)) problems.push(`${path}: ${key} is not a ${type} property`);
  }
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === 'object') problems.push(...validate(value, `${path}.${key}`));
  }
  return problems;
}

const base: VenueJsonLdInput = {
  name: 'Arena Sofia',
  description: 'Eight padel courts under one roof.',
  addressLine: 'бул. България 1',
  city: 'София',
  country: 'BG',
  lat: '42.6977123',
  lng: '23.3219456',
  phone: '+359 2 123 4567',
  url: 'https://playerz.bg/venues/arena-sofia',
  images: [],
  sports: ['Падел', 'Тенис', 'Падел'],
  courts: [
    { basePriceCents: 2400, minBookingMinutes: 60, currency: 'EUR' },
    { basePriceCents: 1500, minBookingMinutes: 30, currency: 'EUR' },
  ],
  locale: 'bg',
};

describe('buildVenueJsonLd (#396)', () => {
  it('is a valid schema.org SportsActivityLocation', () => {
    const ld = buildVenueJsonLd(base);
    expect(ld['@context']).toBe('https://schema.org');
    expect(ld['@type']).toBe('SportsActivityLocation');
    expect(validate(ld)).toEqual([]);
  });

  it('carries the address, the coordinates as numbers, the url and the phone', () => {
    const ld = buildVenueJsonLd(base);
    expect(ld).toMatchObject({
      name: 'Arena Sofia',
      url: 'https://playerz.bg/venues/arena-sofia',
      '@id': 'https://playerz.bg/venues/arena-sofia#venue',
      telephone: '+359 2 123 4567',
      address: {
        '@type': 'PostalAddress',
        streetAddress: 'бул. България 1',
        addressLocality: 'София',
        addressCountry: 'BG',
      },
      geo: { '@type': 'GeoCoordinates', latitude: 42.6977123, longitude: 23.3219456 },
    });
  });

  it('lists each sport once, as an amenity feature', () => {
    const ld = buildVenueJsonLd(base);
    expect(ld.amenityFeature).toEqual([
      { '@type': 'LocationFeatureSpecification', name: 'Падел', value: true },
      { '@type': 'LocationFeatureSpecification', name: 'Тенис', value: true },
    ]);
  });

  it('omits image when there are no photos, and makes photos absolute when there are', () => {
    expect(buildVenueJsonLd(base)).not.toHaveProperty('image');
    const ld = buildVenueJsonLd({
      ...base,
      images: ['/uploads/cover.jpg', 'https://cdn.example/court.jpg'],
    });
    expect(ld.image).toEqual([
      'https://playerz.bg/uploads/cover.jpg',
      'https://cdn.example/court.jpg',
    ]);
    expect(validate(ld)).toEqual([]);
  });

  it('omits what the venue does not have, and stays valid', () => {
    const ld = buildVenueJsonLd({
      ...base,
      description: null,
      phone: null,
      lat: null,
      lng: undefined,
      sports: [],
      courts: [],
    });
    for (const key of ['description', 'telephone', 'geo', 'amenityFeature', 'priceRange']) {
      expect(ld).not.toHaveProperty(key);
    }
    expect(validate(ld)).toEqual([]);
  });

  it('drops coordinates that are not on the globe', () => {
    expect(buildVenueJsonLd({ ...base, lat: 123, lng: 23 })).not.toHaveProperty('geo');
    expect(buildVenueJsonLd({ ...base, lat: 'abc', lng: 23 })).not.toHaveProperty('geo');
  });
});

describe('hourlyPriceRange (#396)', () => {
  it('normalises each court to an hour before taking the range', () => {
    // 24.00 per 60 min, 15.00 per 30 min = 30.00 an hour.
    const range = hourlyPriceRange(base.courts, 'en');
    expect(range).toBe('€24 – €30');
  });

  it('is one price when every court costs the same', () => {
    expect(
      hourlyPriceRange([{ basePriceCents: 2000, minBookingMinutes: 60, currency: 'EUR' }], 'en'),
    ).toBe('€20');
  });

  it('gives nothing for no courts or mixed currencies', () => {
    expect(hourlyPriceRange([], 'en')).toBeUndefined();
    expect(
      hourlyPriceRange(
        [
          { basePriceCents: 2000, minBookingMinutes: 60, currency: 'EUR' },
          { basePriceCents: 4000, minBookingMinutes: 60, currency: 'BGN' },
        ],
        'en',
      ),
    ).toBeUndefined();
  });
});

describe('serializeJsonLd (#396)', () => {
  const hostile = '</script><script>alert(1)</script><!-- &  ';

  it('cannot close the script element, whatever a venue is called', () => {
    const out = serializeJsonLd(buildVenueJsonLd({ ...base, name: hostile }));
    expect(out).not.toContain('</');
    expect(out).not.toContain('<');
    expect(out).not.toContain('>');
    expect(out).not.toContain(' ');
  });

  it('round-trips: a JSON-LD parser reads the original text back', () => {
    const ld = buildVenueJsonLd({ ...base, name: hostile });
    expect(JSON.parse(serializeJsonLd(ld))).toEqual(ld);
  });
});
