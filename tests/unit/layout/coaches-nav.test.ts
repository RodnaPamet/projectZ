import { coachesCrumbs, coachProfileCrumbs } from '@/components/layout/crumbs';
import {
  clubAdminNav,
  MODULE_HREFS,
  MODULES_OFF,
  playerShellNav,
  playerTabs,
  type ChromeModules,
} from '@/components/layout/nav-items';
import { COACH_PROFILE_HREF, COACHES_HREF, coachPath } from '@/lib/coaches/hrefs';
import { COACH_PROFILE_HREF as NOTIFICATION_HREF } from '@/lib/notifications/coach-copy';

/**
 * Where the coaches module shows up in the chrome (#377), and that it shows
 * up nowhere while its switch is off.
 */

const ON: ChromeModules = { ...MODULES_OFF, coaches: true };
const hrefs = (kind: 'player' | 'coach', modules: ChromeModules) =>
  playerShellNav(kind, { modules }).flatMap((s) => s.items.map((i) => i.href));
const t = (key: string) => key;

describe('the coaches module in the navigation', () => {
  it('off: neither a player nor a coach has anything of it', () => {
    for (const kind of ['player', 'coach'] as const) {
      expect(hrefs(kind, MODULES_OFF)).not.toContain(COACHES_HREF);
      expect(hrefs(kind, MODULES_OFF)).not.toContain(COACH_PROFILE_HREF);
    }
    expect(
      clubAdminNav('alfa', 'court', MODULES_OFF).flatMap((s) => s.items.map((i) => i.href)),
    ).not.toContain('/t/alfa/admin/coaches');
  });

  it('on: a player gets «Треньори», before Резервации', () => {
    const items = hrefs('player', ON);
    expect(items).toContain(COACHES_HREF);
    expect(items.indexOf(COACHES_HREF)).toBeLessThan(items.indexOf('/me/bookings'));
    expect(items).not.toContain(COACH_PROFILE_HREF);
  });

  it('on: a coach gets it too (a coach plays), and their own profile before Профил', () => {
    const items = hrefs('coach', ON);
    expect(items).toContain(COACHES_HREF);
    expect(items.indexOf(COACH_PROFILE_HREF)).toBe(items.indexOf('/me/profile') - 1);
  });

  it('on: the club’s owner and manager get its coaches page; the desk does not see it', () => {
    const page = clubAdminNav('alfa', 'court', ON)
      .flatMap((s) => s.items)
      .find((i) => i.href === '/t/alfa/admin/coaches');
    expect(page).toMatchObject({ labelKey: 'coaches', requires: 'admin.staff_manage' });
  });

  it('the phone’s tab bar stays as it was: the module adds no tab', () => {
    for (const kind of ['player', 'coach'] as const) {
      expect(playerTabs(kind, ON).map((x) => x.href)).toEqual(
        playerTabs(kind, MODULES_OFF).map((x) => x.href),
      );
    }
  });

  it('the module’s entry is the public list, and addresses are built in one place', () => {
    expect(MODULE_HREFS.coaches).toBe('/coaches');
    expect(coachPath('ivan-petrov')).toBe('/coaches/ivan-petrov');
    // A notification points where the navigation does.
    expect(NOTIFICATION_HREF).toBe(COACH_PROFILE_HREF);
  });

  it('the trails: Треньори and a coach; Профил and the coach’s own profile', () => {
    expect(coachesCrumbs(t as never)).toEqual([{ label: 'coaches', href: '/coaches' }]);
    expect(coachesCrumbs(t as never, 'Иван Петров').map((c) => c.label)).toEqual([
      'coaches',
      'Иван Петров',
    ]);
    expect(coachProfileCrumbs(t as never)).toEqual([
      { label: 'profile', href: '/me/profile' },
      { label: 'coachProfile', href: '/me/coach' },
    ]);
  });
});
