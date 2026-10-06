import { buildClubJsonLd } from '@/lib/seo/club-jsonld';
import { serializeJsonLd } from '@/lib/seo/venue-jsonld';

/**
 * The club page's structured data (#356): a SportsClub whose `location` is
 * each venue, joined to the venue page's own SportsActivityLocation by `@id`.
 */
describe('buildClubJsonLd', () => {
  const venue = {
    name: 'Падел Лозенец',
    url: 'https://playerz.example/venues/padel-lozenets',
    addressLine: 'ул. Корт 1',
    city: 'Sofia',
    country: 'BG',
    sports: ['Падел', 'Падел', 'Тенис'],
  };

  it('is a SportsClub at the club URL, its venues as locations', () => {
    const ld = buildClubJsonLd({
      name: 'Клуб Алфа',
      url: 'https://playerz.example/clubs/alpha',
      phone: '+359 2 000 000',
      logoUrl: '/logo.png',
      address: venue,
      venues: [venue],
    });

    expect(ld).toMatchObject({
      '@context': 'https://schema.org',
      '@type': 'SportsClub',
      '@id': 'https://playerz.example/clubs/alpha#club',
      name: 'Клуб Алфа',
      url: 'https://playerz.example/clubs/alpha',
      telephone: '+359 2 000 000',
      logo: 'https://playerz.example/logo.png',
      address: { '@type': 'PostalAddress', streetAddress: 'ул. Корт 1', addressLocality: 'Sofia' },
    });
    const [loc] = ld.location as Array<Record<string, unknown>>;
    expect(loc).toMatchObject({
      '@type': 'SportsActivityLocation',
      // The venue page's own @id, so the two pages describe ONE place.
      '@id': 'https://playerz.example/venues/padel-lozenets#venue',
      url: venue.url,
    });
    expect((loc!.amenityFeature as Array<{ name: string }>).map((a) => a.name)).toEqual([
      'Падел',
      'Тенис',
    ]);
  });

  it('leaves out what it does not know, rather than emitting empty values', () => {
    const ld = buildClubJsonLd({
      name: 'Клуб Бета',
      url: 'https://playerz.example/clubs/beta',
      venues: [],
    });
    expect(ld).not.toHaveProperty('telephone');
    expect(ld).not.toHaveProperty('logo');
    expect(ld).not.toHaveProperty('address');
    expect(ld).not.toHaveProperty('location');
  });

  it('no club name can close the script element', () => {
    const ld = buildClubJsonLd({
      name: '</script><script>alert(1)</script>',
      url: 'https://playerz.example/clubs/x',
      venues: [],
    });
    expect(serializeJsonLd(ld)).not.toContain('</script>');
  });
});
