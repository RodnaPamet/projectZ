import { globSync, readFileSync } from 'node:fs';

/**
 * WHO IS ALLOWED TO BYPASS TENANT ISOLATION, PINNED BY NAME.
 *
 * `runAsSuperuser` binds `app_superuser`, which holds BYPASSRLS. Inside it,
 * every policy in the database stops applying: a query sees every club's rows,
 * and nothing raises. It is the one binding with no safety net underneath it.
 *
 * ═══ WHY A PIN, AND NOT A RULE ═══
 *
 * There is no test that can decide whether a given cross-tenant read is
 * legitimate — that is a judgement about the feature. So this does not try. It
 * records the set of files that hold the privilege TODAY, and fails when the
 * set changes, which turns "I reached for the superuser binding" from an
 * invisible edit into a deliberate one somebody has to defend in review.
 *
 * ═══ WHY THIS IS THE GUARDRAIL THAT WAS MISSING ═══
 *
 * `route-db-binding` requires every route to NAME a binding, and it accepts
 * `runAsSuperuser` as a valid answer (BINDINGS, that file). So "this route
 * bypasses RLS entirely" already satisfied the only structural check there was.
 *
 * That matters most right now. P31 added `asPlatformAdmin`, which cannot run
 * without writing an append-only audit row naming who, which grant and why.
 * Without this pin, that door stands beside an open wall: the next feature that
 * needs something `asPlatformAdmin` does not expose just calls
 * `runAsSuperuser`, gets the same reach with none of the accountability, and
 * ships green.
 *
 * And the stakes are not theoretical: `DATABASE_URL` connects as a role that is
 * `rolsuper=true, rolbypassrls=true`, so RLS is a property of the binding
 * rather than of the connection until P24 is adopted.
 *
 * ═══ ADDING A FILE HERE ═══
 *
 * Adding a line to this list is allowed. It is meant to be the moment somebody
 * asks whether the answer is `asPlatformAdmin` — which keeps the same reach and
 * makes it answerable afterwards — and, if it genuinely is not, says in the PR
 * why an unaudited cross-tenant read is right.
 */

/** Every file that may reach for BYPASSRLS, and why the privilege is there. */
const ALLOWED: Record<string, string> = {
  // ── The mechanism itself ────────────────────────────────────────────
  'src/lib/db/rls-middleware.ts': 'defines runAsSuperuser',
  'src/app/api/v1/_lib/bind.ts': 'exposes it to routes as asSuperuser, and now asPlatformAdmin',
  'src/lib/db/platform-admin-context.ts': 'wraps it with the mandatory audit row',

  // ── Sign-in, which must read a User before any tenant exists ────────
  'src/auth.ts': 'the jwt/session callbacks: no tenant is bound during sign-in',
  'src/lib/auth/sessions.ts': 'session rows are keyed on the user, not a tenant',
  'src/lib/auth/verify-credentials.ts': 'reads a User by email before any tenant is known',
  'src/app/api/v1/auth/refresh/route.ts': 'rotates a refresh token with no tenant context',
  'src/lib/auth/platform-admin.ts': 'reads platform_admin_grant, which denies app_user outright',
  'src/lib/auth/page-context.ts':
    'resolves which tenant a PAGE is about, so there is no app.tenant_id to bind yet — ' +
    'tenant_membership carries FORCE RLS and returns zero rows unbound, which every caller ' +
    'would read as "not a member". One row, by (userId, slug), both from the caller\'s own ' +
    'session; it cannot enumerate. Same shape as auth.ts and /t/[slug]/me.',

  // ── Accepting an invite, which is how a tenant is DISCOVERED ────────
  'src/app/(public)/invite/[token]/page.tsx':
    'resolves which club a token belongs to, so there is no app.tenant_id to bind yet — the ' +
    'same chicken-and-egg as page-context. The lookup is by hashForLookup(token), a keyed ' +
    'hash of a secret the visitor supplied; it cannot enumerate, and it is filtered to ' +
    'invites that are unaccepted, unrevoked and unexpired.',
  'src/app/(public)/invite/[token]/actions.ts':
    'consumes that token and creates the membership. Same reason: the membership being ' +
    'created is what would have supplied the binding.',

  // ── Public discovery, which spans every club by design ──────────────
  'src/app/(public)/venues/page.tsx': 'the public venue index spans every club',
  'src/app/api/v1/venues/route.ts': 'public venue list',
  'src/app/api/v1/venues/near/route.ts': 'public geo search',
  'src/app/api/v1/venues/[id]/route.ts': 'public venue detail',
  'src/app/api/v1/venues/[id]/availability/route.ts': 'public availability for a venue',
  'src/app/api/venues/route.ts': 'legacy public venue list',
  'src/app/api/venues/near/route.ts': 'legacy public geo search',

  // ── Machine work with no human actor ────────────────────────────────
  'src/app/api/webhooks/stripe/route.ts': 'Stripe posts with no session and no tenant slug',
  'src/app-layer/usecases/release-expired-bookings.ts': 'the sweeper spans every club',
  'src/app/api/cron/warn-expiring-platform-grants/route.ts':
    'reads grant expiry dates; platform_admin_grant denies app_user, and a cron job is not a person',
  'src/app-layer/usecases/notifications.ts': 'writes a user-bound row after the tenant tx commits',
  'src/app/api/v1/realtime/subscribe/route.ts': 'resolves channel membership before binding',
  'src/app/api/v1/t/[slug]/me/route.ts': 'resolves the membership that the binding needs',
};

describe('the BYPASSRLS surface is pinned', () => {
  const sources = globSync('src/**/*.{ts,tsx}').map((f) => f.toString());

  // `runAsPlatformAdmin` is in here beside the untraced pair, and the reason is
  // worth stating: it is the function that actually opens the BYPASSRLS
  // transaction, and it does NOT check the grant. `asPlatformAdmin` in bind.ts
  // is the only place a live grant and its capability are verified; the layer
  // underneath takes `actorUserId`, `grantId` and `capability` as arguments and
  // believes them. The attribution trigger cannot help — it compares the row's
  // actor to a GUC that the same call sets from the same argument — and
  // `platform_audit_entry` has no foreign key on `grantId`, so a caller with no
  // grant at all gets every club's rows and a well-formed audit row citing a
  // grant that does not exist.
  //
  // So reaching the inner function directly is a BYPASSRLS call site in exactly
  // the sense this file pins, and the three files below that legitimately name
  // it are already listed.
  const reaches = (src: string) =>
    /\b(?:runAsSuperuser|asSuperuser|runAsPlatformAdmin)\b/.test(
      // Comments mentioning the name are documentation, not privilege.
      src
        .split('\n')
        .filter((l) => {
          const t = l.trim();
          return !t.startsWith('*') && !t.startsWith('//') && !t.startsWith('/*');
        })
        .join('\n'),
    );

  it('the scan found the source tree', () => {
    // Without this, a broken glob makes every assertion below vacuous.
    expect(sources.length).toBeGreaterThan(100);
  });

  it('exactly the pinned files reach for it', () => {
    const actual = sources.filter((f) => reaches(readFileSync(f, 'utf8'))).sort();
    const expected = Object.keys(ALLOWED).sort();

    const added = actual.filter((f) => !expected.includes(f));
    const removed = expected.filter((f) => !actual.includes(f));

    if (added.length > 0) {
      throw new Error(
        `These files newly bypass tenant isolation:\n\n` +
          added.map((f) => `  ${f}`).join('\n') +
          `\n\nInside runAsSuperuser every RLS policy stops applying: the query sees every\n` +
          `club's rows and nothing raises.\n\n` +
          `Before adding it to ALLOWED in this file, check whether the answer is\n` +
          `asPlatformAdmin() — same reach, but it cannot run without writing an\n` +
          `append-only row naming who, which grant, which capability and why. If an\n` +
          `UNAUDITED cross-tenant read really is right here, add the file with a reason\n` +
          `and say so in the PR.`,
      );
    }

    // A file dropping off is good news, but the list must follow it or the pin
    // rots into a list of files that no longer exist.
    expect(removed).toEqual([]);
  });

  it('every pinned file still exists and still reaches for it', () => {
    // Otherwise a rename leaves an entry that permits nothing and hides the
    // fact that the privilege moved somewhere unpinned.
    const stale = Object.keys(ALLOWED).filter((f) => !sources.includes(f));
    expect(stale).toEqual([]);
  });

  it('every entry states a reason', () => {
    const unexplained = Object.entries(ALLOWED)
      .filter(([, why]) => why.trim().length < 10)
      .map(([f]) => f);
    expect(unexplained).toEqual([]);
  });

  // ── Negative control ───────────────────────────────────────────────
  it('the detector fires on real usage and not on prose', () => {
    // This whole suite passes by finding a SET, which is indistinguishable from
    // a detector that matches nothing — the state a ratchet reaches the day
    // after somebody simplifies it.
    expect(reaches('const x = await runAsSuperuser((db) => db.user.findMany());')).toBe(true);
    expect(reaches('return asSuperuser(ctx, (db) => db.venue.findMany());')).toBe(true);
    // The inner, grant-unchecked one. `asPlatformAdmin` does not match this —
    // different identifier — which is how a direct call slipped past every
    // guardrail until it was listed here.
    expect(reaches('return runAsPlatformAdmin(act, (db) => db.venueOrg.findMany());')).toBe(true);
    expect(reaches('return asPlatformAdmin(ctx, act, (db) => db.venueOrg.findMany());')).toBe(
      false,
    );

    // …and not on a comment that merely names it.
    expect(reaches(' * See runAsSuperuser for the cross-tenant case.')).toBe(false);
    expect(reaches('// runAsSuperuser would also work here, but does not audit.')).toBe(false);

    // …nor on an unrelated identifier that contains the word.
    expect(reaches('const notRunAsSuperuserish = 1;')).toBe(false);
  });
});
