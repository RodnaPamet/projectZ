import { render, screen, within } from '@testing-library/react';

import CoachPage, { generateMetadata as coachMetadata } from '@/app/(public)/coaches/[slug]/page';
import CoachesPage, { generateMetadata as listMetadata } from '@/app/(public)/coaches/page';
import { VenueCoaches } from '@/app/(public)/venues/[slug]/VenueCoaches';
import type { PublicCoach } from '@/app-layer/usecases/coach-directory';

import bg from '../../messages/bg.json';
import { withIntl } from '../helpers/intl';
import { resolveServerTree } from '../helpers/server-tree';

/**
 * «Треньори», a coach's page and the coaches on a venue page (#547), rendered
 * as the server renders them, against the real Bulgarian catalogue, with the
 * directory stubbed: what each page shows of a coach, and what it does when
 * there is nobody to show.
 */

jest.mock('next-intl/server', () => {
  const { createTranslator, createFormatter } = jest.requireActual('next-intl');
  const messages = require('../../messages/bg.json');
  return {
    getLocale: async () => 'bg',
    getFormatter: async () => createFormatter({ locale: 'bg', timeZone: 'Europe/Sofia' }),
    getTranslations: async (namespace: string) =>
      createTranslator({ locale: 'bg', messages, namespace }),
  };
});

const listPublicCoaches = jest.fn();
const publicCoachSports = jest.fn();
const publicCoachBySlug = jest.fn();
const coachesAtVenue = jest.fn();
jest.mock('@/app-layer/usecases/coach-directory', () => ({
  listPublicCoaches: (...a: unknown[]) => listPublicCoaches(...a),
  publicCoachSports: (...a: unknown[]) => publicCoachSports(...a),
  publicCoachBySlug: (...a: unknown[]) => publicCoachBySlug(...a),
  coachesAtVenue: (...a: unknown[]) => coachesAtVenue(...a),
}));

let signedIn = false;
jest.mock('@/components/layout/player-chrome-data', () => ({
  chromeIdentity: async () => (signedIn ? { userId: 'u1' } : null),
}));
jest.mock('@/components/layout/PageBreadcrumbs', () => ({
  PageBreadcrumbs: ({ items }: { items: Array<{ label: string }> }) => (
    <nav data-testid="crumbs">{items.map((i) => i.label).join(' / ')}</nav>
  ),
}));
// The lesson picker is the page's second stage and has its own tests
// (lesson-booking.test.tsx); here it is a marker that says what it was given.
jest.mock('@/app/(public)/coaches/[slug]/CoachLessons', () => ({
  CoachLessons: ({ coach, name }: { coach: { slug: string }; name: string }) => (
    <div data-testid="coach-lessons" data-coach={coach.slug} data-name={name} />
  ),
  CoachLessonsSkeleton: () => null,
}));
const notFound = jest.fn(() => {
  throw new Error('NEXT_NOT_FOUND');
});
jest.mock('next/navigation', () => ({ notFound: () => notFound() }));

const t = bg.coaches;

const coach = (over: Partial<PublicCoach> = {}): PublicCoach => ({
  slug: 'ivan-petrov',
  name: 'Иван Петров',
  avatarUrl: null,
  bio: 'Треньор по тенис от 2010 г.\nРаботя с начинаещи.',
  qualifications: 'Лиценз ББФТ, ниво 2',
  sports: [
    { sport: 'TENNIS', levelMin: 1, levelMax: 5 },
    { sport: 'PADEL', levelMin: 4, levelMax: 4 },
  ],
  fromRateCents: 3000,
  currency: 'EUR',
  venues: [
    {
      linkId: 'l2',
      venueId: 'v2',
      name: 'Бета Арена',
      city: 'Sofia',
      publicSlug: 'beta-arena',
      timezone: 'Europe/Sofia',
      club: { name: 'Клуб Бета', slug: 'beta' },
      sports: ['TENNIS'],
      hourlyRateCents: 3000,
      groupRateCents: null,
      currency: 'EUR',
      lessonMinutes: [60],
    },
    {
      linkId: 'l1',
      venueId: 'v1',
      name: 'Алфа Кортове',
      city: 'Sofia',
      publicSlug: null,
      timezone: 'Europe/Sofia',
      club: { name: 'Клуб Алфа', slug: 'alfa' },
      sports: ['TENNIS', 'PADEL'],
      hourlyRateCents: 4000,
      groupRateCents: 6000,
      currency: 'EUR',
      lessonMinutes: [60, 90],
    },
  ],
  ...over,
});

async function openList(search: Record<string, string> = {}) {
  const tree = await CoachesPage({ searchParams: Promise.resolve(search) });
  return render(withIntl(await resolveServerTree(tree)));
}
async function openCoach(slug = 'ivan-petrov') {
  const tree = await CoachPage({
    params: Promise.resolve({ slug }),
    searchParams: Promise.resolve({}),
  });
  return render(withIntl(await resolveServerTree(tree)));
}

beforeEach(() => {
  signedIn = false;
  listPublicCoaches.mockReset().mockResolvedValue({ items: [], nextCursor: null });
  publicCoachSports.mockReset().mockResolvedValue([]);
  publicCoachBySlug.mockReset().mockResolvedValue(null);
  coachesAtVenue.mockReset().mockResolvedValue([]);
  notFound.mockClear();
});

describe('«Треньори», the list', () => {
  it('each coach is one link to their page, with what they teach, where, and the price from', async () => {
    listPublicCoaches.mockResolvedValue({ items: [coach()], nextCursor: null });
    await openList();

    expect(screen.getByRole('heading', { level: 1, name: t.title })).toBeVisible();
    const card = screen.getByTestId('coach-card');
    expect(card).toHaveAttribute('href', '/coaches/ivan-petrov');
    expect(card).toHaveTextContent('Иван Петров');
    expect(card).toHaveTextContent('Тенис · Падел');
    expect(card).toHaveTextContent('Бета Арена, София · Алфа Кортове, София');
    expect(within(card).getByTestId('coach-card-price')).toHaveTextContent('от 30,00 € на час');
    // No script of its own and nothing personal beyond the card.
    expect(listPublicCoaches).toHaveBeenCalledWith({ sport: undefined, cursor: null });
    // Signed out: no breadcrumb trail (the header has none to put it in).
    expect(screen.queryByTestId('crumbs')).toBeNull();
  });

  it('with nobody listed it says so, and offers no filter', async () => {
    await openList();
    expect(screen.getByText(t.empty.title)).toBeVisible();
    expect(screen.getByText(t.empty.description)).toBeVisible();
    expect(screen.queryByTestId('coaches-sports')).toBeNull();
    expect(screen.queryByTestId('coaches-next')).toBeNull();
  });

  it('the sport filter is links, one per sport somebody teaches, and marks the one chosen', async () => {
    listPublicCoaches.mockResolvedValue({ items: [coach()], nextCursor: null });
    publicCoachSports.mockResolvedValue(['TENNIS', 'PADEL']);
    await openList({ sport: 'PADEL' });

    const filter = screen.getByTestId('coaches-sports');
    const links = within(filter).getAllByRole('link');
    expect(links.map((l) => [l.textContent, l.getAttribute('href')])).toEqual([
      [t.allSports, '/coaches'],
      ['Тенис', '/coaches?sport=TENNIS'],
      ['Падел', '/coaches?sport=PADEL'],
    ]);
    expect(within(filter).getByRole('link', { name: 'Падел' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(listPublicCoaches).toHaveBeenCalledWith({ sport: 'PADEL', cursor: null });
  });

  it('a sport with nobody says that, not that there are no coaches at all', async () => {
    publicCoachSports.mockResolvedValue(['TENNIS', 'PADEL']);
    await openList({ sport: 'TENNIS' });
    expect(screen.getByText(t.empty.sport)).toBeVisible();
  });

  it('"next" is a link that keeps the sport; a later page offers the way back', async () => {
    listPublicCoaches.mockResolvedValue({ items: [coach()], nextCursor: 'ivan-petrov' });
    publicCoachSports.mockResolvedValue(['TENNIS', 'PADEL']);
    await openList({ sport: 'TENNIS', after: 'boris' });
    expect(listPublicCoaches).toHaveBeenCalledWith({ sport: 'TENNIS', cursor: 'boris' });
    expect(screen.getByTestId('coaches-next')).toHaveAttribute(
      'href',
      '/coaches?sport=TENNIS&after=ivan-petrov',
    );
    expect(screen.getByRole('link', { name: t.first })).toHaveAttribute(
      'href',
      '/coaches?sport=TENNIS',
    );
  });

  it('what is not a sport or a page address in the query is ignored, not passed on', async () => {
    await openList({ sport: 'CURLING', after: 'Not A Slug' });
    expect(listPublicCoaches).toHaveBeenCalledWith({ sport: undefined, cursor: null });
  });

  it('search engines get the one list: a filtered or later page is not indexed', async () => {
    const plain = await listMetadata({ searchParams: Promise.resolve({}) });
    expect(plain).toMatchObject({ title: t.metaTitle, alternates: { canonical: '/coaches' } });
    expect(plain.robots).toBeUndefined();
    for (const search of [{ sport: 'PADEL' }, { after: 'boris' }]) {
      expect((await listMetadata({ searchParams: Promise.resolve(search) })).robots).toEqual({
        index: false,
        follow: true,
      });
    }
  });

  it('signed in, the trail is «Треньори»', async () => {
    signedIn = true;
    await openList();
    expect(screen.getByTestId('crumbs')).toHaveTextContent(bg.common.nav.coaches);
  });
});

describe('a coach’s page', () => {
  it('who they are, what they teach and at what levels, and where for how much', async () => {
    publicCoachBySlug.mockResolvedValue(coach());
    const { container } = await openCoach();

    expect(screen.getByRole('heading', { level: 1, name: 'Иван Петров' })).toBeVisible();
    expect(screen.getByTestId('coach-page-sports')).toHaveTextContent('Тенис: нива 1–5');
    expect(screen.getByTestId('coach-page-sports')).toHaveTextContent('Падел: ниво 4');
    expect(screen.getByText(/Треньор по тенис от 2010 г\./)).toBeVisible();
    expect(screen.getByText('Лиценз ББФТ, ниво 2')).toBeVisible();

    const venues = screen.getAllByTestId('coach-page-venue');
    expect(venues).toHaveLength(2);
    // A venue with a public page links to it.
    expect(within(venues[0]!).getByRole('link', { name: 'Бета Арена' })).toHaveAttribute(
      'href',
      '/venues/beta-arena',
    );
    expect(venues[0]).toHaveTextContent('30,00 € на час');
    expect(venues[0]).toHaveTextContent('Клуб Бета · София');
    expect(venues[0]).toHaveTextContent('уроци по 60 мин');
    expect(venues[0]).not.toHaveTextContent('група');
    // One without is named and not linked.
    expect(within(venues[1]!).queryByRole('link')).toBeNull();
    expect(venues[1]).toHaveTextContent('уроци по 60, 90 мин · за група 60,00 € на час');
    expect(screen.getByText(t.page.courtNote)).toBeVisible();

    // Structured data: a Person, with what the page shows and nothing else.
    const ld = JSON.parse(
      container.querySelector('script[type="application/ld+json"]')!.textContent!,
    );
    expect(ld).toMatchObject({
      '@type': 'Person',
      name: 'Иван Петров',
      jobTitle: 'Треньор',
      knowsAbout: ['Тенис', 'Падел'],
    });
    expect(ld.url).toMatch(/\/coaches\/ivan-petrov$/);
    expect(ld.workLocation.map((w: { name: string }) => w.name)).toEqual([
      'Бета Арена',
      'Алфа Кортове',
    ]);
    expect(JSON.stringify(ld)).not.toMatch(/email|telephone|linkId|l1|l2/);
  });

  it('a coach with a venue has the lesson picker under their text, by their own name', async () => {
    publicCoachBySlug.mockResolvedValue(coach());
    await openCoach();
    const lessons = screen.getByTestId('coach-lessons');
    expect(lessons).toHaveAttribute('data-coach', 'ivan-petrov');
    expect(lessons).toHaveAttribute('data-name', 'Иван Петров');
  });

  it('an approved coach who teaches nowhere yet: the page says so, and is kept out of search', async () => {
    publicCoachBySlug.mockResolvedValue(coach({ venues: [], fromRateCents: null }));
    await openCoach();
    expect(screen.getByTestId('coach-page-nowhere')).toHaveTextContent(t.page.nowhere);
    expect(screen.queryByTestId('coach-page-venues')).toBeNull();
    // And nothing to book a lesson with.
    expect(screen.queryByTestId('coach-lessons')).toBeNull();
    expect(screen.queryByText(t.page.courtNote)).toBeNull();
    const meta = await coachMetadata({ params: Promise.resolve({ slug: 'ivan-petrov' }) });
    expect(meta.robots).toEqual({ index: false, follow: true });
  });

  it('a coach with venues is indexable, under their own name and address', async () => {
    publicCoachBySlug.mockResolvedValue(coach());
    const meta = await coachMetadata({ params: Promise.resolve({ slug: 'ivan-petrov' }) });
    expect(meta).toMatchObject({
      title: 'Иван Петров, треньор | playerz.bg',
      description: 'Иван Петров преподава Тенис, Падел. Вижте къде и на каква цена.',
      alternates: { canonical: '/coaches/ivan-petrov' },
    });
    expect(meta.robots).toBeUndefined();
  });

  it('nobody by that address is a 404, and is not indexed', async () => {
    await expect(openCoach('nobody')).rejects.toThrow('NEXT_NOT_FOUND');
    expect(notFound).toHaveBeenCalledTimes(1);
    expect(await coachMetadata({ params: Promise.resolve({ slug: 'nobody' }) })).toEqual({
      robots: { index: false },
    });
  });

  it('a coach whose account has no name is shown as a coach, not as nothing', async () => {
    publicCoachBySlug.mockResolvedValue(coach({ name: '  ' }));
    await openCoach();
    expect(screen.getByRole('heading', { level: 1, name: t.noName })).toBeVisible();
  });

  it('text a coach typed is shown as text', async () => {
    publicCoachBySlug.mockResolvedValue(
      coach({ bio: '<img src=x onerror=alert(1)> </script><script>alert(2)</script>' }),
    );
    const { container } = await openCoach();
    expect(container.querySelector('img[src="x"]')).toBeNull();
    // The only script is the structured data, and the text cannot close it.
    const scripts = container.querySelectorAll('script');
    expect(scripts).toHaveLength(1);
    expect(scripts[0]!.innerHTML).not.toContain('</script>');
    expect(screen.getByText(/onerror=alert\(1\)/)).toBeVisible();
  });
});

describe('the coaches on a venue page', () => {
  const section = async (venueId = 'v1') =>
    render(withIntl(await resolveServerTree(await VenueCoaches({ venueId }))));

  it('nobody teaches here: no section at all', async () => {
    const { container } = await section();
    expect(container).toBeEmptyDOMElement();
    expect(coachesAtVenue).toHaveBeenCalledWith('v1');
  });

  it('each coach with the rate at THIS venue, and a way to all coaches', async () => {
    // As `coachesAtVenue` hands them over: this venue first, cheaper ones after.
    const here = coach();
    coachesAtVenue.mockResolvedValue([{ ...here, venues: [here.venues[1]!, here.venues[0]!] }]);
    await section();

    const box = screen.getByTestId('venue-coaches');
    expect(within(box).getByRole('heading', { level: 2, name: t.venue.title })).toBeVisible();
    const card = within(box).getByTestId('coach-card');
    // Their page, with the lesson picker already on this venue (#548).
    expect(card).toHaveAttribute('href', '/coaches/ivan-petrov?at=l1');
    // 40 here, though 30 somewhere else: this page is about this venue.
    expect(within(card).getByTestId('coach-card-price')).toHaveTextContent('40,00 € на час');
    expect(within(box).getByRole('link', { name: t.venue.all })).toHaveAttribute(
      'href',
      '/coaches',
    );
  });
});
