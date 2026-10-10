import { resolveClubTabs } from '@/components/layout/club-admin-tab-bar';
import { clubAdminCrumbs } from '@/components/layout/crumbs';
import {
  clubAdminNav,
  clubShell,
  MODULES_OFF,
  toShellSections,
  visibleSections,
} from '@/components/layout/nav-items';
import { getPermissionsForRole } from '@/lib/permissions';

/**
 * The club's Съобщения (#375): an admin nav item and the top bar's icon, for OWNER, MANAGER and STAFF, while the messaging module is on — and
 * nowhere while it is off, which is how it ships.
 */
const ON = { openPlay: false, messaging: true };
const hrefs = (modules = MODULES_OFF) =>
  clubAdminNav('levski', 'court', modules).flatMap((s) => s.items.map((i) => i.href));

const shell = (role: 'OWNER' | 'MANAGER' | 'STAFF' | 'COACH', modules = ON) =>
  clubShell(
    {
      tenantSlug: 'levski',
      tenantName: 'Тенис клуб Левски',
      role,
      permissions: getPermissionsForRole(role),
    },
    {
      platform: [],
      me: { name: 'Иван', email: 'ivan@club.test' },
      t: (k) => k,
      tRole: (k) => k,
      modules,
    },
  );

describe('the club inbox in the club admin (#375)', () => {
  it('module off: no Съобщения item, and no messages icon', () => {
    expect(hrefs()).not.toContain('/t/levski/admin/messages');
    expect(shell('OWNER', MODULES_OFF).messages).toBeNull();
  });

  it('module on: Съобщения beside the diary, for the roles that hold messages.club', () => {
    expect(hrefs(ON)).toContain('/t/levski/admin/messages');
    for (const role of ['OWNER', 'MANAGER', 'STAFF'] as const) {
      expect(shell(role).messages).toEqual({
        href: '/t/levski/admin/messages',
        side: { kind: 'club', slug: 'levski' },
      });
    }
    // A coach is not the club's voice: no item, no icon.
    expect(shell('COACH').messages).toBeNull();
    const coach = visibleSections(clubAdminNav('levski', 'court', ON), (i) =>
      getPermissionsForRole('COACH').includes(i.requires),
    ).flatMap((s) => s.items.map((i) => i.href));
    expect(coach).not.toContain('/t/levski/admin/messages');
  });

  it('it is never a phone tab: the drawer and the header icon carry it (#362)', () => {
    const sections = toShellSections(
      visibleSections(clubAdminNav('levski', 'court', ON), (i) =>
        getPermissionsForRole('STAFF').includes(i.requires),
      ),
      (k) => k,
    );
    expect(resolveClubTabs(sections).map((t) => t.href)).toEqual([
      '/t/levski/admin/calendar',
      '/t/levski/admin/players',
    ]);
  });

  it('its crumb names it whatever the flag says', () => {
    expect(clubAdminCrumbs('levski', (k) => k, 'messages')).toEqual([
      { label: 'admin', href: '/t/levski/admin' },
      { label: 'messages', href: '/t/levski/admin/messages' },
    ]);
  });
});
