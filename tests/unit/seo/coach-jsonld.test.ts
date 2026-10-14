import { buildCoachJsonLd } from '@/lib/seo/coach-jsonld';
import { buildSitemap } from '@/lib/seo/sitemap';

/** A coach's structured data and their place in the sitemap (#547). */

describe('buildCoachJsonLd', () => {
  const full = {
    url: 'https://playerz.bg/coaches/ivan-petrov',
    name: 'Иван Петров',
    jobTitle: 'Треньор',
    image: 'https://media.playerz.bg/avatars/a.webp',
    description: 'Треньор по тенис.',
    sports: ['Тенис', 'Падел'],
    venues: [
      { name: 'Алфа Кортове', url: 'https://playerz.bg/venues/alfa' },
      { name: 'Бета Арена', url: null },
    ],
  };

  it('a Person with what the page shows', () => {
    expect(buildCoachJsonLd(full)).toEqual({
      '@context': 'https://schema.org',
      '@type': 'Person',
      name: 'Иван Петров',
      url: 'https://playerz.bg/coaches/ivan-petrov',
      jobTitle: 'Треньор',
      image: 'https://media.playerz.bg/avatars/a.webp',
      description: 'Треньор по тенис.',
      knowsAbout: ['Тенис', 'Падел'],
      workLocation: [
        {
          '@type': 'SportsActivityLocation',
          name: 'Алфа Кортове',
          url: 'https://playerz.bg/venues/alfa',
        },
        { '@type': 'SportsActivityLocation', name: 'Бета Арена' },
      ],
    });
  });

  it('leaves out what there is none of, rather than sending null', () => {
    const bare = buildCoachJsonLd({
      ...full,
      image: null,
      description: null,
      sports: [],
      venues: [],
    });
    expect(Object.keys(bare).sort()).toEqual(['@context', '@type', 'jobTitle', 'name', 'url']);
  });

  it('a long text is cut for the description', () => {
    const ld = buildCoachJsonLd({ ...full, description: 'я'.repeat(900) });
    expect((ld.description as string).length).toBe(500);
  });
});

describe('the sitemap with coaches', () => {
  const origin = new URL('https://playerz.bg');
  const when = new Date('2026-10-14T08:00:00Z');

  it('lists /coaches and each coach’s page after the venues and clubs', () => {
    const map = buildSitemap(
      origin,
      [],
      [],
      [
        { slug: 'anna', updatedAt: when },
        { slug: 'boris', updatedAt: when },
      ],
    );
    expect(map.map((e) => e.url)).toEqual([
      'https://playerz.bg/',
      'https://playerz.bg/venues',
      'https://playerz.bg/coaches',
      'https://playerz.bg/coaches/anna',
      'https://playerz.bg/coaches/boris',
    ]);
    expect(map[3]!.lastModified).toBe(when);
  });

  it('with nobody listed, /coaches is not offered either', () => {
    const map = buildSitemap(origin, [], [], []);
    expect(map.map((e) => e.url)).toEqual(['https://playerz.bg/', 'https://playerz.bg/venues']);
  });
});
