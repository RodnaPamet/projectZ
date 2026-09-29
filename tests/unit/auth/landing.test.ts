import type { MembershipStatus, Role, TenantStatus } from '@prisma/client';

import {
  clubHome,
  clubIndexTarget,
  COACH_HOME,
  contextForPath,
  decideLanding,
  isClubRole,
  landingContexts,
  PLAYER_CONTEXT,
  PLAYER_HOME,
  postSignInPath,
  safeCallbackPath,
  START_PATH,
  type LandingMembership,
} from '@/lib/auth/landing';
import { getPermissionsForRole } from '@/lib/permissions';

/**
 * WHERE A PERSON LANDS AFTER SIGNING IN (#227).
 *
 * The rule is a table in the issue, and every row of it is pinned here, along
 * with the ways a membership can EXIST without COUNTING. Those are the cases
 * that fail quietly: an admin landing for a suspended member is not an error
 * anybody sees, it is a wrong page that renders.
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

const land = (memberships: LandingMembership[], lastUsed: string | null = null) =>
  decideLanding({ memberships, lastUsed });

describe('decideLanding — the table in #227, row by row', () => {
  it('none → the player UI', () => {
    const d = land([]);

    expect(d.context).toBe(PLAYER_CONTEXT);
    expect(d.context.href).toBe(PLAYER_HOME);
    expect(d.reason).toBe('only-context');
    expect(d.contexts).toEqual([PLAYER_CONTEXT]);
  });

  it('PLAYER at one club → the player UI', () => {
    const d = land([membership({ role: 'PLAYER' })]);

    expect(d.context.href).toBe(PLAYER_HOME);
    expect(d.reason).toBe('only-context');
  });

  it('PLAYER at several clubs → the player UI, and still ONE context', () => {
    // The player UI spans clubs. Three PLAYER memberships are not three
    // things to switch between — offering them would be a switcher with three
    // entries leading to the same page.
    const d = land([
      membership({ role: 'PLAYER' }),
      membership({ role: 'PLAYER' }),
      membership({ role: 'PLAYER' }),
    ]);

    expect(d.context.href).toBe(PLAYER_HOME);
    expect(d.contexts).toHaveLength(1);
  });

  it.each(['OWNER', 'MANAGER', 'STAFF'] as const)('%s → the club UI for THAT club', (role) => {
    const m = membership({ role, tenantSlug: 'sofia-padel' });
    const d = land([m]);

    expect(d.context).toMatchObject({ kind: 'club', tenantId: m.tenantId, role });
    expect(d.context.href).toBe('/t/sofia-padel/admin/calendar');
    expect(d.reason).toBe('default');
  });

  it('COACH → the player UI, because there is no coach UI yet', () => {
    const d = land([membership({ role: 'COACH' })]);

    expect(COACH_HOME).toBeNull();
    expect(d.context.href).toBe(PLAYER_HOME);
    // And no switcher entry that leads to the same page as "player" does.
    expect(d.contexts).toEqual([PLAYER_CONTEXT]);
  });

  it('several → the one last used, when it is still theirs', () => {
    const a = membership({ role: 'OWNER', tenantSlug: 'a' });
    const b = membership({ role: 'STAFF', tenantSlug: 'b' });

    expect(land([a, b], `club:${b.tenantId}`)).toMatchObject({
      reason: 'last-used',
      context: { kind: 'club', tenantId: b.tenantId },
    });
    expect(land([a, b], 'player')).toMatchObject({ reason: 'last-used', context: PLAYER_CONTEXT });
  });

  it('several, nothing remembered → the club UI, not the player UI', () => {
    // THE DEFAULT, and a choice the owner may revisit. Every club role holder
    // also holds the player context, so a player-first default would mean the
    // OWNER row above never fired.
    const staff = membership({ role: 'STAFF', tenantSlug: 'front-desk' });
    const player = membership({ role: 'PLAYER' });

    const d = land([player, staff]);

    expect(d.reason).toBe('default');
    expect(d.context).toMatchObject({ kind: 'club', tenantSlug: 'front-desk' });
    expect(d.contexts.map((c) => c.kind)).toEqual(['player', 'club']);
  });

  it('an owner who books a court at somebody else’s club still lands on their own', () => {
    // Booking anywhere creates a PLAYER membership (#229). A default that
    // counted it would flip an owner's landing the day they played elsewhere.
    const own = membership({ role: 'OWNER', tenantSlug: 'mine' });

    const before = land([own]);
    const after = land([own, membership({ role: 'PLAYER', tenantSlug: 'theirs' })]);

    expect(after.context.href).toBe(before.context.href);
    expect(after.context.href).toBe('/t/mine/admin/calendar');
  });
});

describe('decideLanding — a membership that exists is not a role that is held', () => {
  it.each(['INVITED', 'SUSPENDED', 'EXPIRED'] as const)(
    'a %s club membership earns no club landing and no switcher entry',
    (status) => {
      const d = land([membership({ role: 'OWNER', status })]);

      expect(d.context).toBe(PLAYER_CONTEXT);
      expect(d.contexts).toEqual([PLAYER_CONTEXT]);
    },
  );

  it.each(['SUSPENDED', 'CLOSED'] as const)(
    'a club that is itself %s is not landed on, even by its OWNER',
    (tenantStatus) => {
      const d = land([membership({ role: 'OWNER', tenantStatus })]);

      expect(d.context).toBe(PLAYER_CONTEXT);
      expect(d.contexts).toEqual([PLAYER_CONTEXT]);
    },
  );

  it('the live club is chosen over a deactivated one, whatever the order', () => {
    const closed = membership({ role: 'OWNER', tenantStatus: 'CLOSED', tenantSlug: 'closed' });
    const suspended = membership({ role: 'OWNER', status: 'SUSPENDED', tenantSlug: 'gone' });
    const live = membership({ role: 'STAFF', tenantSlug: 'live' });

    const d = land([closed, suspended, live]);

    expect(d.context).toMatchObject({ kind: 'club', tenantSlug: 'live' });
    expect(d.contexts.map((c) => c.key)).toEqual(['player', `club:${live.tenantId}`]);
  });

  it('a status the enums do not have yet counts as NOT live', () => {
    // Equality with ACTIVE, not exclusion of the known bad values: a status
    // added to either enum later must not start granting landings by default.
    const d = land([
      membership({ role: 'OWNER', status: 'PAUSED' as MembershipStatus }),
      membership({ role: 'OWNER', tenantStatus: 'ARCHIVED' as TenantStatus }),
    ]);

    expect(d.contexts).toEqual([PLAYER_CONTEXT]);
  });

  it('a role this code has never heard of earns nothing', () => {
    const d = land([membership({ role: 'SUPERADMIN' as Role })]);

    expect(d.contexts).toEqual([PLAYER_CONTEXT]);
  });
});

describe('decideLanding — a stale last-used is ignored, never obeyed', () => {
  it('points at a club they no longer belong to → the default', () => {
    const own = membership({ role: 'MANAGER', tenantSlug: 'current' });

    const d = land([own], 'club:cformerclub0000000000000');

    expect(d.reason).toBe('default');
    expect(d.context).toMatchObject({ kind: 'club', tenantSlug: 'current' });
  });

  it('points at a club where they were SUSPENDED since → the default', () => {
    const was = membership({ role: 'OWNER', status: 'SUSPENDED', tenantSlug: 'was' });
    const is = membership({ role: 'STAFF', tenantSlug: 'is' });

    const d = land([was, is], `club:${was.tenantId}`);

    expect(d.reason).toBe('default');
    expect(d.context).toMatchObject({ tenantSlug: 'is' });
  });

  it('points at a club that was suspended since → the default', () => {
    const shut = membership({ role: 'OWNER', tenantStatus: 'SUSPENDED', tenantSlug: 'shut' });
    const open = membership({ role: 'OWNER', tenantSlug: 'open' });

    expect(land([shut, open], `club:${shut.tenantId}`).context).toMatchObject({
      tenantSlug: 'open',
    });
  });

  it('points at a club where they are now only a PLAYER → the default', () => {
    // Demoted. The club is still theirs to play at, but not to run.
    const demoted = membership({ role: 'PLAYER', tenantSlug: 'demoted' });
    const other = membership({ role: 'STAFF', tenantSlug: 'other' });

    const d = land([demoted, other], `club:${demoted.tenantId}`);

    expect(d.context).toMatchObject({ tenantSlug: 'other' });
  });

  it('a stale value leaves a player-only person on the player UI', () => {
    const d = land([membership({ role: 'PLAYER' })], 'club:cformerclub0000000000000');

    expect(d.context).toBe(PLAYER_CONTEXT);
    expect(d.reason).toBe('only-context');
  });

  it.each(['', 'club:', 'CLUB:x', 'player ', 'coach:whatever', '{"kind":"club"}'])(
    'garbage (%j) is the same as nothing',
    (garbage) => {
      const own = membership({ role: 'OWNER', tenantSlug: 'own' });
      expect(land([own], garbage)).toMatchObject({
        reason: 'default',
        context: { tenantSlug: 'own' },
      });
    },
  );
});

describe('decideLanding — several clubs', () => {
  it('the default is the highest role, not the first club joined', () => {
    const staffFirst = membership({ role: 'STAFF', createdAt: new Date('2024-01-01') });
    const managerNext = membership({ role: 'MANAGER', createdAt: new Date('2025-01-01') });
    const ownerLast = membership({ role: 'OWNER', createdAt: new Date('2026-01-01') });

    expect(land([staffFirst, managerNext, ownerLast]).context).toMatchObject({
      tenantId: ownerLast.tenantId,
    });
    expect(land([staffFirst, managerNext]).context).toMatchObject({
      tenantId: managerNext.tenantId,
    });
  });

  it('two clubs at the same role → the one joined first, whatever the input order', () => {
    const older = membership({ role: 'OWNER', createdAt: new Date('2025-03-01') });
    const newer = membership({ role: 'OWNER', createdAt: new Date('2026-03-01') });

    expect(land([newer, older]).context).toMatchObject({ tenantId: older.tenantId });
    expect(land([older, newer]).context).toMatchObject({ tenantId: older.tenantId });
  });

  it('an exact tie is still broken the same way every time', () => {
    const when = new Date('2026-05-05T10:00:00Z');
    const a = membership({ role: 'OWNER', createdAt: when, tenantId: 'caaaaaaaaaaaaaaaaaaaaaaaa' });
    const b = membership({ role: 'OWNER', createdAt: when, tenantId: 'cbbbbbbbbbbbbbbbbbbbbbbbb' });

    expect(land([b, a]).context).toMatchObject({ tenantId: a.tenantId });
    expect(land([a, b]).context).toMatchObject({ tenantId: a.tenantId });
  });

  it('lists every club they run, by name, after the player context', () => {
    const d = land([
      membership({ role: 'STAFF', tenantName: 'Varna Tennis' }),
      membership({ role: 'PLAYER', tenantName: 'Burgas Beach' }),
      membership({ role: 'OWNER', tenantName: 'Ask Padel' }),
      membership({ role: 'MANAGER', tenantName: 'Plovdiv Squash' }),
    ]);

    expect(
      d.contexts.map((c) => (c.kind === 'club' ? `${c.tenantName}/${c.role}` : c.kind)),
    ).toEqual(['player', 'Ask Padel/OWNER', 'Plovdiv Squash/MANAGER', 'Varna Tennis/STAFF']);
  });

  it('a club listed twice by a careless caller is offered once', () => {
    const m = membership({ role: 'OWNER' });

    expect(land([m, { ...m }]).contexts).toHaveLength(2);
  });

  it('keys contexts by tenant ID, so renaming a club does not orphan last-used', () => {
    const m = membership({ role: 'OWNER', tenantSlug: 'old-name' });
    const key = `club:${m.tenantId}`;

    const renamed = { ...m, tenantSlug: 'new-name', tenantName: 'New Name' };
    const d = land([renamed], key);

    expect(d.reason).toBe('last-used');
    expect(d.context.href).toBe('/t/new-name/admin/calendar');
  });
});

describe('the coach UI is a one-line change', () => {
  const coachHome = (slug: string) => `/t/${slug}/coach`;

  it('with a coach home set, a COACH lands on it', () => {
    const d = decideLanding(
      { memberships: [membership({ role: 'COACH', tenantSlug: 'academy' })] },
      { coachHome },
    );

    expect(d.context).toMatchObject({ kind: 'coach', href: '/t/academy/coach' });
    expect(d.contexts.map((c) => c.kind)).toEqual(['player', 'coach']);
  });

  it('…and a club role still wins the default over coaching', () => {
    const d = decideLanding(
      {
        memberships: [
          membership({ role: 'COACH', createdAt: new Date('2020-01-01') }),
          membership({ role: 'STAFF', tenantSlug: 'desk', createdAt: new Date('2026-01-01') }),
        ],
      },
      { coachHome },
    );

    expect(d.context).toMatchObject({ kind: 'club', tenantSlug: 'desk' });
  });

  it('…and a remembered coach context is honoured', () => {
    const coach = membership({ role: 'COACH', tenantSlug: 'academy' });
    const d = decideLanding(
      {
        memberships: [coach, membership({ role: 'OWNER' })],
        lastUsed: `coach:${coach.tenantId}`,
      },
      { coachHome },
    );

    expect(d).toMatchObject({ reason: 'last-used', context: { href: '/t/academy/coach' } });
  });

  it('…and the club index sends a coach there too', () => {
    expect(clubIndexTarget('COACH', 'academy', { coachHome })).toBe('/t/academy/coach');
    expect(clubIndexTarget('COACH', 'academy')).toBe(PLAYER_HOME);
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

describe('contextForPath — what the switcher marks as current', () => {
  const sofia = membership({ role: 'OWNER', tenantSlug: 'sofia' });
  const sofiaPadel = membership({ role: 'STAFF', tenantSlug: 'sofia-padel' });
  const contexts = landingContexts([sofia, sofiaPadel]);

  it.each([
    ['/t/sofia/admin/calendar', 'sofia'],
    ['/t/sofia/admin/courts', 'sofia'],
    ['/t/sofia/admin', 'sofia'],
    ['/t/sofia-padel/admin/players', 'sofia-padel'],
  ])('%s is club %s', (path, slug) => {
    expect(contextForPath(contexts, path)).toMatchObject({ kind: 'club', tenantSlug: slug });
  });

  it.each([
    '/',
    '/venues',
    '/me/bookings',
    '/t/sofia',
    '/t/sofia/open-play',
    '/t/sofia/administer',
  ])('%s is the player context', (path) => {
    expect(contextForPath(contexts, path)).toBe(PLAYER_CONTEXT);
  });

  it('a club they do not run is not current just because the URL names it', () => {
    expect(contextForPath(contexts, '/t/elsewhere/admin/calendar')).toBe(PLAYER_CONTEXT);
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

describe('the shared player context', () => {
  it('cannot be edited by a caller that was handed it', () => {
    // One object backs every decision. A caller that rewrote `href` on the
    // copy it was given would re-route every later sign-in in the process.
    const d = land([]);
    expect(() => {
      (d.context as { href: string }).href = '/somewhere-else';
    }).toThrow(TypeError);
    expect(land([]).context.href).toBe(PLAYER_HOME);
  });
});
