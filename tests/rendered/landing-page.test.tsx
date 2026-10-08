import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import type { PilotClub } from '@/app-layer/usecases/pilot-clubs';
import HomeLayout from '@/app/(home)/layout';
import HomePage from '@/app/(home)/page';

import { withIntl } from '../helpers/intl';
import { resolveServerTree } from '../helpers/server-tree';

import bg from '../../messages/bg.json';
import en from '../../messages/en.json';

/**
 * THE LANDING PAGE (#369), RENDERED IN BOTH LANGUAGES.
 *
 * The real page and its sections, with the real catalogues: the hero and its
 * one fully prefetched link into /venues, the players' section, the pilot clubs
 * (live, or the "coming soon" state, never invented), the "For clubs" section
 * and its form, and the closing band. In English nothing Bulgarian may show,
 * and in Bulgarian nothing English but the brand and a club's own name.
 *
 * `next-intl/server` sits behind a `react-server` export condition, so it is
 * mocked here with next-intl's own `createTranslator` over the real catalogue
 * (ICU plurals and rich text included). The chrome (header, footer, tab bar)
 * has its own tests; here it is a marked wrapper.
 */

let locale: 'bg' | 'en' = 'bg';
jest.mock('next-intl/server', () => {
  const { createTranslator } = jest.requireActual('next-intl');
  return {
    getLocale: async () => locale,
    getTranslations: async (namespace: string) =>
      createTranslator({
        locale,
        messages:
          locale === 'en' ? require('../../messages/en.json') : require('../../messages/bg.json'),
        namespace,
      }),
  };
});

// The chrome is tested on its own (player-chrome); here it is a marked
// wrapper. `chromeIdentity` is its identity read, which the layout asks.
let identity: { userId: string; name: string | null; email: string | null } | null = null;
jest.mock('@/components/layout/player-chrome', () => ({
  PlayerChrome: ({ children, footer }: { children: React.ReactNode; footer?: boolean }) => (
    <div data-testid="player-chrome" data-footer={String(!!footer)}>
      {children}
    </div>
  ),
  chromeIdentity: async () => identity,
}));

const redirect = jest.fn((href: string) => {
  throw new Error(`NEXT_REDIRECT ${href}`);
});
jest.mock('next/navigation', () => ({
  ...jest.requireActual('next/navigation'),
  redirect: (href: string) => redirect(href),
}));

let clubs: PilotClub[] = [];
jest.mock('@/app-layer/usecases/pilot-clubs', () => ({
  loadPilotClubs: async () => clubs,
}));

// Which legal texts exist (#370): the privacy one, unless a test says not.
let privacyHref: string | null = '/privacy';
jest.mock('@/lib/legal/texts', () => ({
  legalHrefs: async () => ({ privacy: privacyHref, terms: null, cookies: null }),
}));

const submitContactAction = jest.fn();
jest.mock('@/app/(home)/actions', () => ({
  submitContactAction: (...a: unknown[]) => submitContactAction(...a),
}));

const PILOT: PilotClub[] = [
  {
    id: 'c1',
    slug: 'padel-lozenets',
    name: 'Padel Lozenets',
    cities: ['Sofia'],
    sports: ['PADEL', 'TENNIS'],
    venueCount: 2,
    cover: null,
  },
];

/** The page inside its layout, as `/` serves it to a visitor. */
async function renderPage(l: 'bg' | 'en', query: { account?: string } = {}) {
  locale = l;
  const page = await HomeLayout({
    children: await HomePage({ searchParams: Promise.resolve(query) }),
  });
  return render(withIntl(await resolveServerTree(page), l));
}

/** Visible text and the accessible strings a screen reader reads. */
function allCopy(container: HTMLElement): string {
  const attrs = [...container.querySelectorAll('[aria-label],[placeholder],[title],[alt]')].flatMap(
    (el) => ['aria-label', 'placeholder', 'title', 'alt'].map((a) => el.getAttribute(a) ?? ''),
  );
  // JSON-LD is data for crawlers, not copy.
  const clone = container.cloneNode(true) as HTMLElement;
  clone.querySelectorAll('script').forEach((s) => s.remove());
  return `${clone.textContent ?? ''} ${attrs.join(' ')}`;
}

beforeEach(() => {
  clubs = [];
  identity = null;
  redirect.mockClear();
  submitContactAction.mockReset();
});

describe('signed in, `/` is Играй (#362)', () => {
  it('a signed-in account is sent to /venues by the layout, before the landing renders', async () => {
    identity = { userId: 'u1', name: 'Ivo', email: 'ivo@example.bg' };
    await expect(HomeLayout({ children: <p>landing</p> })).rejects.toThrow('NEXT_REDIRECT /venues');
    expect(redirect).toHaveBeenCalledWith('/venues');
  });

  it('a visitor gets the landing, in the public chrome with its footer', async () => {
    await renderPage('bg');
    expect(redirect).not.toHaveBeenCalled();
    expect(screen.getByTestId('player-chrome')).toHaveAttribute('data-footer', 'true');
    expect(screen.queryByTestId('landing-account-deleted')).not.toBeInTheDocument();
  });

  it('a deleted account lands here and is told so, in one line (#370)', async () => {
    await renderPage('bg', { account: 'deleted' });
    expect(screen.getByTestId('landing-account-deleted')).toHaveTextContent(
      bg.landing.accountDeleted,
    );
  });
});

describe.each([
  ['bg', bg],
  ['en', en],
] as const)('the landing page in %s', (l, messages) => {
  const m = messages.landing;

  it('the hero: one h1, the lead, "find a court" into /venues, and "for clubs" to the form', async () => {
    await renderPage(l);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(m.hero.title);
    expect(screen.getByText(m.hero.lead)).toBeInTheDocument();
    const cta = screen.getByTestId('landing-find-court');
    expect(cta).toHaveAttribute('href', '/venues');
    expect(cta).toHaveTextContent(m.hero.cta);
    expect(cta).toHaveAttribute('data-perf-ready');
    expect(screen.getByRole('link', { name: m.hero.forClubs })).toHaveAttribute('href', '#clubs');
    // Its layout wears the chrome WITH the footer and its language switch.
    expect(screen.getByTestId('player-chrome')).toHaveAttribute('data-footer', 'true');
  });

  it('the players section names all four promises', async () => {
    await renderPage(l);
    const section = screen.getByTestId('landing-players');
    for (const k of ['search', 'instant', 'payAtClub', 'team'] as const) {
      expect(within(section).getByText(m.players[k].title)).toBeInTheDocument();
      expect(within(section).getByText(m.players[k].body)).toBeInTheDocument();
    }
  });

  it('no pilot club yet: the "coming soon" state, pointing at the form, and no card', async () => {
    await renderPage(l);
    const section = screen.getByTestId('landing-pilot-clubs');
    expect(within(section).getByText(m.clubsList.empty.title)).toBeInTheDocument();
    expect(within(section).getByRole('link', { name: m.clubsList.empty.action })).toHaveAttribute(
      'href',
      '#clubs',
    );
    expect(within(section).queryByTestId('pilot-clubs')).toBeNull();
  });

  it('the pilot clubs, as read: name to the club page, city, venue count and sports', async () => {
    clubs = PILOT;
    await renderPage(l);
    const list = screen.getByTestId('pilot-clubs');
    expect(within(list).getByRole('link', { name: 'Padel Lozenets' })).toHaveAttribute(
      'href',
      '/clubs/padel-lozenets',
    );
    expect(list).toHaveTextContent(messages.cities.sofia);
    expect(list).toHaveTextContent(l === 'bg' ? '2 обекта' : '2 venues');
    expect(list).toHaveTextContent(messages.sports.PADEL);
    expect(list).toHaveTextContent(messages.sports.TENNIS);
  });

  it('"for clubs": the benefits, the form with its labels, and the privacy link', async () => {
    await renderPage(l);
    const section = screen.getByTestId('landing-clubs');
    expect(section).toHaveAttribute('id', 'clubs');
    for (const k of ['diary', 'free', 'payAtClub', 'onboarding'] as const) {
      expect(within(section).getByText(m.clubs[k].title)).toBeInTheDocument();
    }
    const f = m.clubs.form;
    for (const label of [f.name, f.clubName, f.phone, f.email, f.message]) {
      expect(within(section).getByLabelText(new RegExp(`^${label}`))).toBeInTheDocument();
    }
    expect(within(section).getByRole('link', { name: /Privacy|поверителност/ })).toHaveAttribute(
      'href',
      '/privacy',
    );
    expect(within(section).getByRole('button', { name: f.submit })).toBeInTheDocument();
  });

  it('with no privacy text yet, the form’s line has no link to a 404 (#370)', async () => {
    privacyHref = null;
    try {
      await renderPage(l);
      const line = screen.getByTestId('contact-privacy');
      expect(line).toHaveTextContent(m.clubs.form.privacyNoLink);
      expect(within(line).queryByRole('link')).toBeNull();
    } finally {
      privacyHref = '/privacy';
    }
  });

  it('the closing band links to /venues too', async () => {
    await renderPage(l);
    const band = screen.getByTestId('landing-closing');
    expect(within(band).getByRole('link', { name: m.closing.cta })).toHaveAttribute(
      'href',
      '/venues',
    );
  });

  it('structured data: Organization and WebSite on the canonical origin', async () => {
    const { container } = await renderPage(l);
    const ld = JSON.parse(
      container.querySelector('script[type="application/ld+json"]')!.textContent!,
    ) as { '@graph': Array<Record<string, unknown>> };
    expect(ld['@graph'].map((n) => n['@type'])).toEqual(['Organization', 'WebSite', 'WebPage']);
    expect(ld['@graph'][2]).toMatchObject({ inLanguage: l, description: m.metaDescription });
  });
});

describe('no language leaks on the landing page', () => {
  const CYRILLIC = /[Ѐ-ӿ]/;

  it('English shows no Cyrillic (with clubs and without)', async () => {
    for (const c of [[], PILOT]) {
      clubs = c;
      const { container, unmount } = await renderPage('en');
      expect(allCopy(container)).not.toMatch(CYRILLIC);
      unmount();
    }
  });

  it('Bulgarian shows no English word but the brand and a club’s own name', async () => {
    clubs = PILOT;
    const { container } = await renderPage('bg');
    const latinWords = (allCopy(container).match(/[A-Za-z]{3,}/g) ?? []).filter(
      (w) => !['playerz', 'Padel', 'Lozenets'].includes(w),
    );
    expect(latinWords).toEqual([]);
  });
});

describe('the contact form', () => {
  const f = bg.landing.clubs.form;

  async function fillAndSend() {
    await renderPage('bg');
    const user = userEvent.setup();
    const form = within(screen.getByTestId('contact-form'));
    await user.type(form.getByLabelText(new RegExp(`^${f.name}`)), 'Мария');
    await user.type(form.getByLabelText(new RegExp(`^${f.clubName}`)), 'Клуб');
    await user.type(form.getByLabelText(new RegExp(`^${f.phone}`)), '0888123456');
    await user.type(form.getByLabelText(new RegExp(`^${f.message}`)), 'Здравейте');
    await user.click(screen.getByRole('button', { name: f.submit }));
  }

  it('posts the fields, the honeypot empty, and thanks the visitor', async () => {
    submitContactAction.mockResolvedValue({ ok: true });
    await fillAndSend();
    expect(await screen.findByTestId('contact-success')).toHaveTextContent(f.success.body);
    const form = submitContactAction.mock.calls[0]![1] as FormData;
    expect(Object.fromEntries(form.entries())).toEqual({
      name: 'Мария',
      clubName: 'Клуб',
      phone: '0888123456',
      email: '',
      message: 'Здравейте',
      website: '',
    });
  });

  it('shows the server’s field errors in the visitor’s language, and keeps what they typed', async () => {
    submitContactAction.mockResolvedValue({
      ok: false,
      code: 'invalid',
      fieldErrors: { phone: 'phone', email: 'email' },
    });
    await fillAndSend();
    expect(await screen.findByText(f.errors.phone)).toBeInTheDocument();
    expect(screen.getByText(f.errors.email)).toBeInTheDocument();
    expect(screen.getByLabelText(new RegExp(`^${f.name}`))).toHaveValue('Мария');
  });

  it('says so when the visitor is rate-limited', async () => {
    submitContactAction.mockResolvedValue({ ok: false, code: 'rateLimited' });
    await fillAndSend();
    expect(await screen.findByTestId('contact-error')).toHaveTextContent(f.errors.rateLimited);
  });

  it('a stale page after a deploy (the action throws) asks for a reload, not an error page', async () => {
    submitContactAction.mockRejectedValue(new Error('UnrecognizedActionError'));
    await fillAndSend();
    expect(await screen.findByTestId('contact-error')).toHaveTextContent(f.errors.unavailable);
  });
});
