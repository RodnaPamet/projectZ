import { render, screen, within } from '@testing-library/react';

import { AdminSidebar } from '@/components/layout/admin-sidebar';
import {
  clubAdminNav,
  platformItemAllowed,
  platformNav,
  toShellSections,
  visibleSections,
  type NavItem,
  type NavSection,
} from '@/components/layout/nav-items';
import { SidebarCollapseProvider } from '@/components/layout/sidebar-collapse-context';
import { getPermissionsForRole } from '@/lib/permissions';

import { foreignWordsIn } from '../helpers/foreign-vocabulary';
import { enMessages, messages as bgMessages, withIntl } from '../helpers/intl';

/**
 * The club-admin and platform nav: what it links to, in both languages (T19).
 *
 * This replaced `app-nav.test.tsx` when AppNav went. The builders are data
 * (`nav-items.ts`); the layouts filter them by the database-resolved
 * permissions and translate them on the server; `AdminSidebar` renders the
 * result. So the test does the same three steps and asserts on what a person
 * would see.
 *
 * ═══ BOTH LANGUAGES, AND NO COMPLIANCE NOUNS IN EITHER ═══
 *
 * The labels are asserted in Bulgarian AND English, from the real catalogues.
 * The old test asserted only Bulgarian, and `withIntl(…, 'en')` silently
 * rendered Bulgarian anyway, so an English label was never checked at all.
 * Every rendered label is also checked against `foreign-vocabulary.ts`, so a
 * re-port of inflect's sidebar content ("Risks", "Рискове") fails here.
 */
jest.mock('next/navigation', () => ({
  usePathname: () => `/t/${SLUG}/admin/courts`,
  useRouter: () => ({ push: jest.fn(), prefetch: jest.fn(), refresh: jest.fn() }),
}));

const SLUG = 'sofia-padel';

type Catalogue = typeof bgMessages;
const translator = (m: Catalogue) => (key: string) =>
  (m.common.nav as Record<string, string>)[key] ?? `common.nav.${key}`;

function renderNav(sections: NavSection[], locale: 'bg' | 'en' = 'bg') {
  const t = translator(locale === 'en' ? enMessages : bgMessages);
  return render(
    withIntl(
      <SidebarCollapseProvider collapsed={false}>
        <AdminSidebar sections={toShellSections(sections, t)} contextName="Sofia Padel" />
      </SidebarCollapseProvider>,
      locale,
    ),
  );
}

const ownerSections = () =>
  visibleSections(clubAdminNav(SLUG), (i) => getPermissionsForRole('OWNER').includes(i.requires));

const LABELS = {
  bg: {
    calendar: 'Календар',
    courts: 'Кортове',
    pricing: 'Ценообразуване',
    players: 'Играчи',
    staff: 'Персонал',
    sectionVenue: 'Обект',
    sectionPeople: 'Хора',
  },
  en: {
    calendar: 'Calendar',
    courts: 'Courts',
    pricing: 'Pricing',
    players: 'Players',
    staff: 'Staff',
    sectionVenue: 'Venue',
    sectionPeople: 'People',
  },
} as const;

describe.each(['bg', 'en'] as const)('club admin nav, in %s', (locale) => {
  it('shows every link to an owner, in sections, with the club-scoped hrefs', () => {
    renderNav(ownerSections(), locale);
    const nav = screen.getByRole('navigation', {
      name: (locale === 'en' ? enMessages : bgMessages).common.ui.mainNav,
    });

    const L = LABELS[locale];
    for (const [label, page] of [
      [L.calendar, 'calendar'],
      [L.courts, 'courts'],
      [L.pricing, 'pricing'],
      [L.players, 'players'],
      [L.staff, 'staff'],
    ] as const) {
      expect(within(nav).getByRole('link', { name: label })).toHaveAttribute(
        'href',
        `/t/${SLUG}/admin/${page}`,
      );
    }
    expect(within(nav).getAllByRole('link')).toHaveLength(5);
    expect(nav).toHaveTextContent(L.sectionVenue);
    expect(nav).toHaveTextContent(L.sectionPeople);
  });

  it('carries no compliance vocabulary, and no untranslated key', () => {
    const { container } = renderNav(ownerSections(), locale);
    const text = container.textContent ?? '';
    expect(foreignWordsIn(text, locale)).toEqual([]);
    expect(text).not.toMatch(/common\.nav\./);
  });
});

describe('club admin nav, by role', () => {
  it('hides what the role cannot open: a STAFF member has no pricing or staff screen', () => {
    const staff = getPermissionsForRole('STAFF');
    renderNav(visibleSections(clubAdminNav(SLUG), (i) => staff.includes(i.requires)));
    for (const label of ['Ценообразуване', 'Персонал']) {
      expect(screen.queryByRole('link', { name: label })).not.toBeInTheDocument();
    }
  });

  it('a COACH keeps the permission-based view it has today: Players only', () => {
    const coach = getPermissionsForRole('COACH');
    const sections = visibleSections(clubAdminNav(SLUG), (i) => coach.includes(i.requires));
    renderNav(sections);
    expect(screen.getAllByRole('link').map((a) => a.getAttribute('href'))).toEqual([
      `/t/${SLUG}/admin/players`,
    ]);
  });

  it('a PLAYER membership opens none of it, so the layout answers 404', () => {
    const player = getPermissionsForRole('PLAYER');
    expect(visibleSections(clubAdminNav(SLUG), (i) => player.includes(i.requires))).toEqual([]);
  });

  it('marks the current page active', () => {
    renderNav(ownerSections());
    // The vendored NavItem paints its active recipe with the brand label tone.
    expect(screen.getByRole('link', { name: 'Кортове' }).className).toContain('text-content-brand');
    expect(screen.getByRole('link', { name: 'Календар' }).className).not.toContain(
      'text-content-brand',
    );
  });
});

describe('platform nav', () => {
  it('offers moderation to a REVIEW_MODERATE holder, and nothing to anyone else', () => {
    const has = visibleSections(platformNav(), (i) => platformItemAllowed(i, ['REVIEW_MODERATE']));
    renderNav(has);
    expect(screen.getByRole('link', { name: 'Модерация' })).toHaveAttribute(
      'href',
      '/platform/moderation',
    );
    expect(visibleSections(platformNav(), () => false)).toEqual([]);
    expect(visibleSections(platformNav(), (i) => platformItemAllowed(i, []))).toEqual([]);
  });

  it('offers the security page (#262) to every grant holder, whatever the grant carries', () => {
    // Enrolling a second factor is open to any live grant; a TENANT_READ holder
    // has no moderation link but must still be able to reach security.
    const readOnly = visibleSections(platformNav(), (i) => platformItemAllowed(i, ['TENANT_READ']));
    renderNav(readOnly);
    expect(screen.getByRole('link', { name: 'Сигурност' })).toHaveAttribute(
      'href',
      '/platform/security',
    );
    expect(screen.queryByRole('link', { name: 'Модерация' })).toBeNull();
  });
});

describe('prefetch policy (docs/perf/navigation-policy.md)', () => {
  it("every admin and platform item prefetches 'auto', never in full", () => {
    const items = [...clubAdminNav(SLUG), ...platformNav()].flatMap((s): NavItem[] => s.items);
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) expect(item.prefetch).toBe('auto');
  });
});
