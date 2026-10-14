import { clubAdminCrumbs } from '@/components/layout/crumbs';
import {
  clubAdminNav,
  MODULE_HREFS,
  MODULES_OFF,
  playerShellNav,
  type ChromeModules,
} from '@/components/layout/nav-items';

/**
 * Where the ranking module shows up in the chrome (#575): the club's
 * «Резултати», for the desk, and nothing while its switch is off. A player's
 * result lives on the booking, a player's ranking on their own page, and a
 * club's leaderboard on the club's page: a player's navigation does not change.
 */
const ON: ChromeModules = { ...MODULES_OFF, ranking: true };
const clubHrefs = (modules: ChromeModules) =>
  clubAdminNav('alfa', 'court', modules).flatMap((s) => s.items.map((i) => i.href));
const t = (key: string) => key;

describe('the ranking module in the navigation', () => {
  it('off: the club has no «Резултати» and no «Турнири»', () => {
    expect(clubHrefs(MODULES_OFF)).not.toContain('/t/alfa/admin/results');
    expect(clubHrefs(MODULES_OFF)).not.toContain('/t/alfa/admin/tournaments');
  });

  it('on: the desk runs the club’s «Турнири» too (#579, decision 52)', () => {
    const item = clubAdminNav('alfa', 'court', ON)
      .flatMap((s) => s.items)
      .find((i) => i.href === '/t/alfa/admin/tournaments');
    expect(item).toMatchObject({
      labelKey: 'tournaments',
      iconKey: 'tournaments',
      requires: 'bookings.view_all',
    });
  });

  it('on: the club’s desk gets «Резултати», by the diary’s permission', () => {
    const item = clubAdminNav('alfa', 'court', ON)
      .flatMap((s) => s.items)
      .find((i) => i.href === '/t/alfa/admin/results');
    expect(item).toMatchObject({
      labelKey: 'results',
      iconKey: 'results',
      requires: 'bookings.view_all',
    });
  });

  it('on: a player’s and a coach’s navigation are as they were', () => {
    for (const kind of ['player', 'coach'] as const) {
      const off = playerShellNav(kind, { modules: MODULES_OFF }).flatMap((s) =>
        s.items.map((i) => i.href),
      );
      const on = playerShellNav(kind, { modules: ON }).flatMap((s) => s.items.map((i) => i.href));
      expect(on).toEqual(off);
      // Ranking's entry is the profile a player already has (#576).
      expect(on).toContain(MODULE_HREFS.ranking);
    }
  });

  it('the crumbs name the page as the sidebar does', () => {
    expect(clubAdminCrumbs('alfa', t as never, 'results').at(-1)).toMatchObject({
      label: 'results',
    });
  });
});
