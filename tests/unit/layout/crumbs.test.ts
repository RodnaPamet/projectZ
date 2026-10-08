import {
  bookingsCrumbs,
  clubAdminCrumbs,
  platformCrumbs,
  playCrumbs,
  profileCrumbs,
} from '@/components/layout/crumbs';

import bg from '../../../messages/bg.json';

/**
 * Every shell page's trail is built from the nav's own items (#362), so a
 * crumb never names a page differently from the sidebar. The last crumb is the
 * page; the vendored `Breadcrumbs` draws it as the current page, whatever its
 * href.
 */

const n = bg.common.nav;
const t = (key: string) => {
  const value = key
    .split('.')
    .reduce<unknown>((m, k) => (m as Record<string, unknown> | undefined)?.[k], n);
  if (typeof value !== 'string') throw new Error(`no common.nav.${key}`);
  return value;
};

describe('the trails', () => {
  it('Играй, and a venue or a club under it', () => {
    expect(playCrumbs(t)).toEqual([{ label: n.play, href: '/venues' }]);
    expect(playCrumbs(t, 'Sofia Padel Club')).toEqual([
      { label: n.play, href: '/venues' },
      { label: 'Sofia Padel Club' },
    ]);
  });

  it('Резервации, and a booking; Профил', () => {
    expect(bookingsCrumbs(t, 'Sofia Padel Club')).toEqual([
      { label: n.bookings, href: '/me/bookings' },
      { label: 'Sofia Padel Club' },
    ]);
    expect(profileCrumbs(t)).toEqual([{ label: n.profile, href: '/me/profile' }]);
  });

  it('the club admin: its home, then the page under the sidebar’s label', () => {
    expect(clubAdminCrumbs('sofia', t)).toEqual([{ label: n.admin, href: '/t/sofia/admin' }]);
    expect(clubAdminCrumbs('sofia', t, 'pricing')).toEqual([
      { label: n.admin, href: '/t/sofia/admin' },
      { label: n.pricing, href: '/t/sofia/admin/pricing' },
    ]);
    // The courts screen is named after what the club plays on, as in the sidebar.
    expect(clubAdminCrumbs('sofia', t, 'courts', 'track')[1]?.label).toBe(n.track.courts);
    expect(clubAdminCrumbs('sofia', t, 'courts', 'mixed')[1]?.label).toBe(n.mixed.courts);
  });

  it('the platform: Платформа, the page, and a leaf below it', () => {
    expect(platformCrumbs(t, 'contact-requests')).toEqual([
      { label: n.platform, href: '/platform' },
      { label: n.contactRequests, href: '/platform/contact-requests' },
    ]);
    expect(platformCrumbs(t, 'fees', 'Отчет')).toEqual([
      { label: n.platform, href: '/platform' },
      { label: n.fees, href: '/platform/fees' },
      { label: 'Отчет' },
    ]);
  });

  it('a page the nav does not have is a programming error, not a quiet crumb', () => {
    expect(() => clubAdminCrumbs('sofia', t, 'nope' as never)).toThrow(/no club admin page/);
    expect(() => platformCrumbs(t, 'nope' as never)).toThrow(/no platform page/);
  });
});
