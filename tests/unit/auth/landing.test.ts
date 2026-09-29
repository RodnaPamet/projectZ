import type { AccountKind, MembershipStatus, Role, TenantStatus } from '@prisma/client';

import {
  clubHome,
  clubIndexTarget,
  COACH_HOME,
  decideLanding,
  HOME,
  isClubRole,
  PLAYER_HOME,
  postSignInPath,
  safeCallbackPath,
  START_PATH,
  type LandingMembership,
} from '@/lib/auth/landing';
import { getPermissionsForRole } from '@/lib/permissions';

/**
 * WHERE A PERSON LANDS AFTER SIGNING IN — BY ACCOUNT KIND (#263).
 *
 * #227 landed people by the MIX of roles they held, and remembered which of
 * several contexts they last chose. The owner has since decided that an
 * account is one kind — PLAYER, CLUB (one club), COACH — so the kind decides
 * and there is nothing to remember. Every row of that table is pinned here,
 * and so are the ways a membership can EXIST without COUNTING: those fail
 * quietly, as a wrong page that renders.
 *
 * The accounts #263's migration left UNDECIDED (kind NULL) keep #227's old
 * default, and its tie-breaks are pinned for them.
 */

let seq = 0;

function membership(over: Partial<LandingMembership> & { role: Role }): LandingMembership {
  seq += 1;
  return {
    tenantId: `ctenant${String(seq).padStart(20, '0')}`,
    tenantSlug: `club-${seq}`,
    tenantName: `Club ${seq}`,
    status: 'ACTIVE' as MembershipStatus,
    tenantStatus: 'ACTIVE' as TenantStatus,
    createdAt: new Date(Date.UTC(2026, 0, seq)),
    ...over,
  };
}

const land = (kind: AccountKind | null, memberships: LandingMembership[] = []) =>
  decideLanding({ kind, memberships });

describe('decideLanding — by the kind of account', () => {
  it('a PLAYER account lands on the player UI', () => {
    expect(land('PLAYER')).toEqual({ href: PLAYER_HOME, reason: 'player', club: null });
  });

  it('…however many clubs it plays at — PLAYER rows decide nothing', () => {
    const d = land('PLAYER', [membership({ role: 'PLAYER' }), membership({ role: 'PLAYER' })]);
    expect(d.href).toBe(PLAYER_HOME);
  });

  it('a CLUB account lands on its one club’s diary, and names the club', () => {
    const club = membership({ role: 'MANAGER', tenantSlug: 'sofia', tenantName: 'Sofia Padel' });

    expect(land('CLUB', [club])).toEqual({
      href: '/t/sofia/admin/calendar',
      reason: 'club',
      club: { tenantId: club.tenantId, tenantSlug: 'sofia', tenantName: 'Sofia Padel' },
    });
  });

  it.each(['OWNER', 'MANAGER', 'STAFF'] as const)('…whether it is %s there', (role) => {
    expect(land('CLUB', [membership({ role, tenantSlug: 'x' })]).href).toBe('/t/x/admin/calendar');
  });

  it('a CLUB account whose club is gone lands on the home page — never the player UI', () => {
    // A club account is not a player, so "your bookings" is a page about
    // somebody it is not. `club-unavailable` says why, for the header.
    expect(land('CLUB')).toEqual({ href: HOME, reason: 'club-unavailable', club: null });
  });

  it('a COACH account lands on the player UI for now', () => {
    // There is no coach UI: COACH_HOME is the one line that changes that.
    expect(COACH_HOME).toBeNull();
    expect(land('COACH', [membership({ role: 'COACH' })])).toEqual({
      href: PLAYER_HOME,
      reason: 'coach',
      club: null,
    });
  });
});

describe('decideLanding — a membership that exists is not a role that is held', () => {
  it.each(['INVITED', 'SUSPENDED', 'EXPIRED'] as const)(
    'a %s club membership does not land a club account on the club',
    (status) => {
      expect(land('CLUB', [membership({ role: 'OWNER', status })]).reason).toBe('club-unavailable');
    },
  );

  it.each(['SUSPENDED', 'CLOSED'] as const)('nor does a club that is %s', (tenantStatus) => {
    expect(land('CLUB', [membership({ role: 'OWNER', tenantStatus })]).href).toBe(HOME);
  });

  it('a status nobody has decided about yet counts as NOT live', () => {
    // Equality with ACTIVE, not exclusion of the known bad values.
    const d = land('CLUB', [membership({ role: 'OWNER', status: 'PENDING' as MembershipStatus })]);
    expect(d.reason).toBe('club-unavailable');
  });

  it('a role this file has never heard of earns no club landing', () => {
    const d = land(null, [membership({ role: 'ARCHDUKE' as Role })]);
    expect(d).toEqual({ href: PLAYER_HOME, reason: 'undecided', club: null });
  });
});

describe('decideLanding — an UNDECIDED account keeps #227’s default', () => {
  // Club roles at two or more clubs, or a coach role, when #263 arrived. The
  // owner said not to decide these by rule; until a person does, signing in
  // lands them exactly where it used to.

  it('the club UI over the player UI', () => {
    const d = land(null, [
      membership({ role: 'PLAYER' }),
      membership({ role: 'STAFF', tenantSlug: 'desk' }),
    ]);
    expect(d).toMatchObject({ href: '/t/desk/admin/calendar', reason: 'undecided' });
  });

  it('the highest club role first', () => {
    const d = land(null, [
      membership({ role: 'STAFF', tenantSlug: 'staffed', createdAt: new Date('2020-01-01') }),
      membership({ role: 'OWNER', tenantSlug: 'owned', createdAt: new Date('2026-01-01') }),
      membership({ role: 'MANAGER', tenantSlug: 'managed', createdAt: new Date('2019-01-01') }),
    ]);
    expect(d.club?.tenantSlug).toBe('owned');
  });

  it('then the oldest membership', () => {
    const d = land(null, [
      membership({ role: 'OWNER', tenantSlug: 'newer', createdAt: new Date('2026-01-01') }),
      membership({ role: 'OWNER', tenantSlug: 'older', createdAt: new Date('2020-01-01') }),
    ]);
    expect(d.club?.tenantSlug).toBe('older');
  });

  it('then the tenant id, so two made in the same millisecond order the same way every time', () => {
    const at = new Date('2026-01-01');
    const a = membership({ role: 'OWNER', tenantId: 'ctenant-b', tenantSlug: 'b', createdAt: at });
    const b = membership({ role: 'OWNER', tenantId: 'ctenant-a', tenantSlug: 'a', createdAt: at });

    expect(land(null, [a, b]).club?.tenantSlug).toBe('a');
    expect(land(null, [b, a]).club?.tenantSlug).toBe('a');
  });

  it('with no live club role, the player UI', () => {
    expect(land(null, [membership({ role: 'OWNER', status: 'SUSPENDED' })]).href).toBe(PLAYER_HOME);
  });
});

describe('the coach UI is a one-line change', () => {
  const coachHome = (slug: string) => `/t/${slug}/coach`;

  it('with a coach home set, a COACH account lands on its oldest affiliation', () => {
    const d = decideLanding(
      {
        kind: 'COACH',
        memberships: [
          membership({ role: 'COACH', tenantSlug: 'newer', createdAt: new Date('2026-01-01') }),
          membership({ role: 'COACH', tenantSlug: 'academy', createdAt: new Date('2020-01-01') }),
        ],
      },
      { coachHome },
    );

    expect(d).toMatchObject({ href: '/t/academy/coach', reason: 'coach' });
    expect(d.club?.tenantSlug).toBe('academy');
  });

  it('…an undecided account with a club role still goes to the club first', () => {
    const d = decideLanding(
      {
        kind: null,
        memberships: [
          membership({ role: 'COACH', createdAt: new Date('2020-01-01') }),
          membership({ role: 'STAFF', tenantSlug: 'desk', createdAt: new Date('2026-01-01') }),
        ],
      },
      { coachHome },
    );

    expect(d.href).toBe('/t/desk/admin/calendar');
  });

  it('…and an undecided coach with no club role goes to the coach UI', () => {
    const d = decideLanding(
      { kind: null, memberships: [membership({ role: 'COACH', tenantSlug: 'academy' })] },
      { coachHome },
    );

    expect(d).toMatchObject({ href: '/t/academy/coach', reason: 'undecided' });
  });

  it('…and the club index sends a coach there too', () => {
    expect(clubIndexTarget('COACH', 'academy', { coachHome })).toBe('/t/academy/coach');
    expect(clubIndexTarget('COACH', 'academy')).toBe(PLAYER_HOME);
  });
});

describe('decideLanding — what a deep link still wins over', () => {
  it('the default a sign-in with no destination falls back to is /start', () => {
    // `/login` honours `?next=` first; landing by kind is only ever the
    // answer for a sign-in that asked for nothing. See postSignInPath below.
    expect(postSignInPath({})).toBe(START_PATH);
    expect(postSignInPath({ next: '/t/x/admin/staff' })).toBe('/t/x/admin/staff');
  });
});

describe('the club landing page is one every club role can open', () => {
  it.each(['OWNER', 'MANAGER', 'STAFF'] as const)(
    '%s holds bookings.view_all, which the diary requires',
    (role) => {
      // Landing somebody on a page their role cannot see is a 404 at sign-in.
      // Courts, pricing and staff are closed to STAFF, which is why the diary
      // is the landing page. If this permission ever moves, this fails
      // before a front-desk account does.
      expect(getPermissionsForRole(role)).toContain('bookings.view_all');
      expect(clubHome('x')).toBe('/t/x/admin/calendar');
    },
  );

  it('isClubRole admits exactly the three', () => {
    expect(['OWNER', 'MANAGER', 'STAFF', 'COACH', 'PLAYER', 'toString'].filter(isClubRole)).toEqual(
      ['OWNER', 'MANAGER', 'STAFF'],
    );
  });
});

describe('clubIndexTarget — /t/[slug], by the role held there', () => {
  it.each([
    ['OWNER', '/t/x/admin/calendar'],
    ['MANAGER', '/t/x/admin/calendar'],
    ['STAFF', '/t/x/admin/calendar'],
    ['COACH', PLAYER_HOME],
    ['PLAYER', PLAYER_HOME],
  ] as const)('%s → %s', (role, target) => {
    expect(clubIndexTarget(role, 'x')).toBe(target);
  });
});

describe('safeCallbackPath — a deep link may win, an open redirect may not', () => {
  it.each([
    ['/t/sofia/admin/staff', '/t/sofia/admin/staff'],
    ['/t/sofia/admin/calendar?day=2026-10-01', '/t/sofia/admin/calendar?day=2026-10-01'],
    ['/invite/abc123', '/invite/abc123'],
    ['/me/bookings#next', '/me/bookings#next'],
    ['/start', '/start'],
    ['/venues?q=padel%20club', '/venues?q=padel%20club'],
  ])('keeps a path on this site: %s', (raw, expected) => {
    expect(safeCallbackPath(raw)).toBe(expected);
  });

  it.each([
    ['protocol-relative', '//evil.example/steal'],
    ['protocol-relative, backslash', '/\\evil.example'],
    ['a backslash anywhere', '/t/x\\..\\..'],
    ['tab, which the URL parser strips', '/\t/evil.example'],
    ['newline', '/\n/evil.example'],
    ['carriage return', '/\r/evil.example'],
    ['NUL', '/\u0000/evil.example'],
    ['DEL', '/\u007f/evil.example'],
    ['leading space', ' /me/bookings'],
    ['dot segments that normalise to //', '/..//evil.example'],
    ['single dot segment', '/.//evil.example'],
    ['encoded dot segments', '/%2e%2e//evil.example'],
    ['absolute, another host', 'https://evil.example/t/x'],
    ['javascript:', 'javascript:alert(1)'],
    ['data:', 'data:text/html,<script>alert(1)</script>'],
    ['relative without a slash', 'me/bookings'],
    ['empty', ''],
    ['absurdly long', `/${'a'.repeat(2048)}`],
  ])('refuses %s', (_why, raw) => {
    expect(safeCallbackPath(raw, 'https://app.playerz.bg')).toBeNull();
  });

  it.each([
    ['the home page — no intent, and next-auth’s own fallback', '/'],
    ['the home page with a query', '/?from=header'],
    ['/login, which would loop', '/login'],
    ['/login with a query', '/login?error=OAuthSignin'],
    ['an API route', '/api/auth/signout'],
    ['the API root', '/api'],
  ])('treats %s as no destination', (_why, raw) => {
    expect(safeCallbackPath(raw)).toBeNull();
  });

  it.each([undefined, null, 42, ['/me/bookings'], { href: '/me/bookings' }])(
    'refuses a non-string (%j) — a repeated query parameter arrives as an array',
    (raw) => {
      expect(safeCallbackPath(raw)).toBeNull();
    },
  );

  describe('absolute URLs, which next-auth produces on a retry', () => {
    const origin = 'https://app.playerz.bg';

    it('keeps one on this origin, as a path', () => {
      expect(safeCallbackPath('https://app.playerz.bg/t/x/admin/staff?y=1', origin)).toBe(
        '/t/x/admin/staff?y=1',
      );
    });

    it.each([
      'http://app.playerz.bg/t/x', // scheme differs
      'https://app.playerz.bg:8443/t/x', // port differs
      'https://evil.app.playerz.bg/t/x', // a subdomain is another origin
      'https://app.playerz.bg.evil.example/t/x', // suffix trick
      'https://user@evil.example/t/x', // userinfo trick
      'https://app.playerz.bg//evil.example', // protocol-relative path on our origin
    ])('refuses %s', (raw) => {
      expect(safeCallbackPath(raw, origin)).toBeNull();
    });

    it('refuses every absolute URL when the app origin is unknown', () => {
      expect(safeCallbackPath('https://app.playerz.bg/t/x')).toBeNull();
      expect(safeCallbackPath('https://app.playerz.bg/t/x', null)).toBeNull();
      expect(safeCallbackPath('https://app.playerz.bg/t/x', 'not a url')).toBeNull();
    });

    it('treats our own origin, bare, as no destination', () => {
      // `options.callbackUrl` is the bare origin when next-auth had nothing
      // better — /api/auth/signin with no parameter.
      expect(safeCallbackPath('https://app.playerz.bg', origin)).toBeNull();
    });
  });
});

describe('postSignInPath — what /login hands to next-auth', () => {
  it('no destination → /start, which lands by role', () => {
    expect(postSignInPath({})).toBe(START_PATH);
    expect(START_PATH).toBe('/start');
  });

  it('?next= wins — it is what the app itself writes', () => {
    expect(postSignInPath({ next: '/invite/tok' })).toBe('/invite/tok');
  });

  it('?callbackUrl= is honoured when there is no next', () => {
    expect(postSignInPath({ callbackUrl: '/t/x/admin/courts' })).toBe('/t/x/admin/courts');
  });

  it('next beats callbackUrl when both are present', () => {
    expect(postSignInPath({ next: '/me/bookings', callbackUrl: '/t/x/admin/courts' })).toBe(
      '/me/bookings',
    );
  });

  it('an unsafe next falls through to a safe callbackUrl, then to /start', () => {
    expect(postSignInPath({ next: '//evil.example', callbackUrl: '/me/bookings' })).toBe(
      '/me/bookings',
    );
    expect(postSignInPath({ next: '//evil.example', callbackUrl: 'https://evil.example' })).toBe(
      START_PATH,
    );
  });

  it('the old default of "/" now means role landing, not the home page', () => {
    expect(postSignInPath({ callbackUrl: '/' })).toBe(START_PATH);
  });

  it('uses the app origin for next-auth’s absolute retry URLs', () => {
    expect(
      postSignInPath(
        { callbackUrl: 'http://localhost:3000/t/x/admin/staff' },
        'http://localhost:3000',
      ),
    ).toBe('/t/x/admin/staff');
  });
});
