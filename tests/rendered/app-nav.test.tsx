import { render, screen } from '@testing-library/react';

import { ADMIN_NAV, AppNav, PLAYER_NAV } from '@/components/layout/AppNav';

import { withIntl } from '../helpers/intl';

/**
 * playerz's nav, not inflect's.
 *
 * P02 refused to port `SidebarNav` because its items were /controls,
 * /risks, /evidence — a compliance IA. This asserts the replacement is
 * actually a sports IA, and that permission gating hides what it should.
 *
 * ═══ THE LABELS ARE BULGARIAN, AND THAT IS THE POINT ═══
 *
 * This file used to assert 'Play', 'Courts', 'Calendar'. It passed, because the
 * nav really did render those — nine literal English strings on the most
 * visible surface in an app whose default locale is bg.
 *
 * A test that asserts the wrong copy is worse than no test: it turns a defect
 * into a documented expectation. Asserting the Bulgarian is what makes the nav
 * being English a FAILURE rather than a fact somebody has to notice.
 */
describe('AppNav', () => {
  it('renders the player surface', () => {
    render(withIntl(<AppNav items={PLAYER_NAV} />));

    for (const label of ['Играй', 'Свободна игра', 'Треньори', 'Моите резервации']) {
      expect(screen.getByRole('link', { name: label })).toBeInTheDocument();
    }
  });

  it('carries NO compliance vocabulary', () => {
    render(
      withIntl(
        <AppNav items={[...PLAYER_NAV, ...ADMIN_NAV]} permissions={['bookings.view_all']} />,
      ),
    );

    // The regression this exists to prevent: quietly re-porting inflect's
    // nav and shipping a booking app with a "Risks" tab.
    for (const forbidden of [
      'Controls',
      'Risks',
      'Evidence',
      'Policies',
      'Vendors',
      'Frameworks',
    ]) {
      expect(screen.queryByRole('link', { name: forbidden })).not.toBeInTheDocument();
    }
  });

  it('hides admin links the viewer has no permission for', () => {
    render(withIntl(<AppNav items={ADMIN_NAV} permissions={['courts.manage']} />));

    expect(screen.getByRole('link', { name: 'Кортове' })).toBeInTheDocument();

    // The ABSENT names must be in the rendered locale too. These read 'Pricing'
    // and 'Staff' a moment ago and passed — but only because the nav renders
    // Bulgarian, so they were absent for the wrong reason entirely and proved
    // nothing about permission gating. A negative assertion against copy that
    // could never appear is a test that has quietly stopped testing.
    expect(screen.queryByRole('link', { name: 'Ценообразуване' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Персонал' })).not.toBeInTheDocument();
  });

  it('shows every admin link to a fully-privileged viewer', () => {
    render(
      withIntl(
        <AppNav
          items={ADMIN_NAV}
          permissions={[
            'bookings.view_all',
            'courts.manage',
            'admin.pricing_manage',
            'players.view',
            'admin.staff_manage',
          ]}
        />,
      ),
    );
    expect(screen.getAllByRole('link')).toHaveLength(ADMIN_NAV.length);
  });
});
