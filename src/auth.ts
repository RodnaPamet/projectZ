import type { NextAuthOptions } from 'next-auth';
import CredentialsProvider from 'next-auth/providers/credentials';
import FacebookProvider from 'next-auth/providers/facebook';
import GoogleProvider from 'next-auth/providers/google';

import {
  FACEBOOK_AUTHORIZATION_URL,
  FACEBOOK_EMAIL_REQUIRED_REDIRECT,
  FACEBOOK_SCOPE,
  FACEBOOK_TOKEN_URL,
  FACEBOOK_USERINFO_FIELDS,
  FACEBOOK_USERINFO_URL,
  facebookPictureFrom,
  facebookRefreshesAvatar,
} from '@/lib/auth/facebook';
import { buildMembershipClaims, type MembershipClaim } from '@/lib/auth/jwt-claims';
import { passwordSignInEnabled } from '@/lib/auth/password-sign-in';
import { createUserSession, newSessionSecret, SESSION_MAX_AGE_SECONDS } from '@/lib/auth/sessions';
import { facebookConfigured, googleConfigured } from '@/lib/auth/sign-in-methods';
import { verifyCredentials } from '@/lib/auth/verify-credentials';
import { getPermissionsForRole } from '@/lib/permissions';
import { runAsSuperuser } from '@/lib/db/rls-middleware';
import { DEFAULT_LOCALE } from '@/lib/i18n/locales';
import { logger } from '@/lib/observability/logger';

/**
 * NextAuth v4.
 *
 * Sign-in runs as app_superuser: at this point no tenant is selected, so
 * there is no `app.tenant_id` to bind, and an RLS-scoped query for the User
 * would return zero rows and look exactly like "wrong password".
 */
// Defined in lib/auth/sessions so that reading it does not pull the whole of
// authOptions — providers and callbacks — into a bundle. Re-exported because
// callers expect it here.
export { SESSION_MAX_AGE_SECONDS } from '@/lib/auth/sessions';

/**
 * Membership rows to claims, skipping a club that is gone.
 *
 * Prisma 7 loads `tenant` with a second select, so a club deleted between the
 * two comes back as `tenant: null` although the relation is required (#419).
 * Reading `.id` off it would fail the sign-in with a TypeError.
 */
function membershipClaimsFrom(
  rows: readonly { role: MembershipClaim['role']; tenant: { id: string; slug: string } | null }[],
): MembershipClaim[] {
  return rows.flatMap(({ role, tenant }) =>
    tenant ? [{ tenantId: tenant.id, tenantSlug: tenant.slug, role }] : [],
  );
}

export const authOptions: NextAuthOptions = {
  /**
   * 7 days, not next-auth's 30-day default.
   *
   * `GET /api/auth/session` re-encodes the JWT and re-chunks the cookie with a
   * FRESH expiry on every single call, ungated — there is no updateAge check on
   * that path (next-auth/core/routes/session.js:60-79). The React client polls
   * it on focus and on an interval, so a session slides for as long as anything
   * holds it open.
   *
   * With UserSession unimplemented there is no revocation to bound that: a
   * stolen cookie that is merely polled never expires. Until sessionVersion is
   * wired, a shorter window is the only thing limiting the damage, and 30 days
   * of unrevocable access is too much to leave as a default nobody chose.
   *
   * This does NOT fix revocation. It shortens the tail.
   */
  session: { strategy: 'jwt', maxAge: SESSION_MAX_AGE_SECONDS },

  /**
   * Point every page at our own UI.
   *
   * With only `signIn` set, next-auth serves its built-in unbranded ENGLISH
   * pages for the rest — from playerz.bg, to an audience whose default locale
   * is Bulgarian. `verify-request` is the worst of them: it says "A sign in
   * link has been sent to your email address" for an app that has no Email
   * provider and never sent one.
   */
  pages: {
    signIn: '/login',
    signOut: '/login',
    error: '/login',
  },

  /**
   * ═══ A PROVIDER IS REGISTERED ONLY WHEN IT IS CONFIGURED ═══
   *
   * These used to be registered unconditionally with `?? ''` for missing
   * credentials, while `src/env.ts` declared the same variables REQUIRED. The
   * two disagreed: env validation refused to boot without them, and the code
   * underneath was written to tolerate their absence.
   *
   * Registering a provider with an empty client id does not fail here. It
   * renders a sign-in button that takes the user to the provider and fails
   * THERE, with a provider-side error page nobody can act on.
   *
   * So: no credentials, no button. `signInMethods()` reports which are live,
   * for the same reason `pushChannels()` exists — "it is off" should be an
   * observation, not a discovery. Both read the same predicates.
   *
   * ═══ GOOGLE AND FACEBOOK, AND NOTHING ELSE IN A DEPLOYMENT (#361) ═══
   *
   * Everyone — players, coaches, club staff, admins — signs in with one of the
   * two (owner decisions Q15/Q21). Microsoft Entra and its club group sync
   * (#114) were removed with that decision; the credentials provider below is
   * registered for the test suites only. The `production-sign-in-providers`
   * guardrail pins the list a production process builds.
   */
  providers: [
    ...(googleConfigured()
      ? [
          GoogleProvider({
            clientId: process.env.GOOGLE_CLIENT_ID ?? '',
            clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? '',
          }),
        ]
      : []),

    /**
     * Facebook Login. Provider id `facebook`, so the redirect URI registered
     * with Meta is `${NEXTAUTH_URL}/api/auth/callback/facebook`, exactly.
     *
     * All three endpoints are overridden: next-auth 4.24 still sends people to
     * Graph v11.0, retired in 2023 — see `@/lib/auth/facebook`.
     *
     * `profile()` is overridden too. next-auth's reads
     * `profile.picture.data.url` without a guard, and a throw there is
     * swallowed by next-auth and turns into a silent bounce back to /login.
     */
    ...(facebookConfigured()
      ? [
          FacebookProvider({
            clientId: process.env.FACEBOOK_CLIENT_ID ?? '',
            clientSecret: process.env.FACEBOOK_CLIENT_SECRET ?? '',
            authorization: {
              url: FACEBOOK_AUTHORIZATION_URL,
              params: { scope: FACEBOOK_SCOPE },
            },
            token: FACEBOOK_TOKEN_URL,
            userinfo: {
              url: FACEBOOK_USERINFO_URL,
              params: { fields: FACEBOOK_USERINFO_FIELDS },
            },
            profile(profile: Record<string, unknown>) {
              return {
                id: String(profile.id ?? ''),
                name: typeof profile.name === 'string' ? profile.name : null,
                // Absent when the person declined the permission or has no
                // usable address. The sign-in callback refuses that, and says
                // why: see FACEBOOK_EMAIL_REQUIRED.
                email: typeof profile.email === 'string' ? profile.email : null,
                image: facebookPictureFrom(profile),
              };
            },
          }),
        ]
      : []),

    /**
     * Email and password: the TEST SUITES ONLY (#361).
     *
     * Registered when `TEST_PASSWORD_SIGN_IN=1` and `DEPLOY_ENV=test`, which
     * the E2E, perf and Jest harnesses set; never in a deployment, whatever
     * the flag says, and a deployment carrying the flag refuses to start. See
     * `@/lib/auth/password-sign-in`. Unregistered, next-auth answers a POST to
     * /api/auth/callback/credentials with a 400 and checks nothing.
     */
    ...(passwordSignInEnabled()
      ? [
          CredentialsProvider({
            name: 'credentials',
            credentials: {
              email: { label: 'Email', type: 'email' },
              password: { label: 'Password', type: 'password' },
            },

            async authorize(credentials) {
              // Shared with the native token endpoint, deliberately. The
              // enumeration defence (equal bcrypt time on every failure path)
              // lives in ONE place; two copies is how one of them loses it.
              return verifyCredentials(credentials?.email, credentials?.password);
            },
          }),
        ]
      : []),
  ],

  callbacks: {
    /**
     * ═══ WHY THERE IS NO ADAPTER, AND WHY THIS EXISTS INSTEAD ═══
     *
     * `adapter: PrismaAdapter(prisma)` used to sit at the top of this object,
     * uncommented — the one line in this file with nothing said about it. It
     * had never run: the credentials provider does not touch an adapter, and
     * no OAuth provider was configured until the first real deploy. The moment
     * one was, every Google sign-in died in the callback:
     *
     *   [next-auth][error][adapter_error_getUserByAccount]
     *   TypeError: Cannot read properties of undefined (reading 'findUnique')
     *
     * `prisma.account` is undefined because THE SCHEMA HAS NO `Account` MODEL.
     * No `Session`, no `VerificationToken` either — the adapter's entire
     * contract is absent. The user was bounced back to /login with no message,
     * which from the outside is "I logged in and came back to the same screen".
     *
     * Adding those three tables was the other option. It is the wrong one:
     *
     *   • This app already owns identity. `app_user.email` is UNIQUE and
     *     `passwordHash` is nullable — one row per person, however they
     *     authenticate. `Account` would be a second source of truth for a fact
     *     we already store.
     *   • Sessions are JWTs. Revocation is `user_session` + `sessionVersion`,
     *     minted by the jwt callback below. next-auth's `Session` table would
     *     be dead weight that still has to be migrated, RLS'd and granted.
     *   • Every table needs an RLS policy and a grant for `playerz_app`, and
     *     the adapter uses the plain `prisma` client — NOT `runAsSuperuser`.
     *     An identity table read before any user context exists, queried under
     *     RLS with nothing bound, is a new hole to reason about for no gain.
     *
     * So: no adapter, and this callback maps a provider identity onto an
     * `app_user` row.
     *
     * Verified against the installed next-auth 4.24.15 rather than assumed:
     * with no adapter `callbackHandler` returns `{ user: profile }` unchanged
     * (core/lib/callback-handler.js:27), and core/routes/callback.js hands the
     * SAME object to `signIn` and then to `jwt`. So rewriting `user.id` here is
     * what the rest of the chain sees — which it must be, because the jwt
     * callback looks up memberships by `user.id` and writes
     * `user_session.userId`, a foreign key to `app_user`.
     */
    async signIn({ user, account, profile }) {
      // Credentials sign-in already resolved a real app_user in authorize().
      if (account?.type !== 'oauth') return true;

      const email = typeof user.email === 'string' ? user.email.trim().toLowerCase() : '';
      if (!email) {
        logger.warn('oauth sign-in refused: the provider returned no email', {
          component: 'auth',
          provider: account.provider,
        });
        // ═══ NO EMAIL, NO ACCOUNT ═══
        //
        // Accounts are found by email, so a sign-in without one has nothing to
        // sign into, and an account created without one could never be found
        // again: the next sign-in would make another. Nothing is written.
        //
        // Facebook is the provider that does this in practice — it leaves the
        // address out when the person unticked it on the consent screen, or
        // when the account has none it will share. That person is told so on
        // the sign-in page, with a button that asks Facebook again and the
        // Google button beside it, rather than a generic "unavailable".
        return account.provider === 'facebook' ? FACEBOOK_EMAIL_REQUIRED_REDIRECT : false;
      }

      // ═══ AN UNVERIFIED EMAIL IS AN ACCOUNT TAKEOVER ═══
      //
      // Identities are linked BY EMAIL, so a provider willing to assert an
      // address its owner has not proved is a route into any existing account
      // holding that address. Google sends `email_verified`, and it is false
      // for Workspace accounts on domains the admin never verified — so this
      // is a real state, not a hypothetical one.
      //
      // Required to be exactly `true`. Absent is not the same as verified, and
      // failing closed costs one sign-in while failing open costs the account.
      const verified = (profile as { email_verified?: boolean } | undefined)?.email_verified;
      if (account.provider === 'google' && verified !== true) {
        logger.warn('google sign-in refused: email_verified was not true', {
          component: 'auth',
        });
        return false;
      }

      // ═══ FACEBOOK SENDS NO email_verified, SO THERE IS NOTHING TO CHECK ═══
      //
      // Graph's `/me` carries the address and no claim about it. Meta documents
      // only that `email` "will not be returned if no valid email address is
      // available". Linking by it relies on Facebook releasing an address only
      // once its owner has confirmed it with Facebook — so a present address is
      // taken as proved, the standard `email_verified: true` sets for Google.
      //
      // That is TRUST in Meta, not a check made here, and it is the trade #361
      // accepted: were Facebook ever to release an unconfirmed address, its
      // holder would be linked to the existing account with that address. Not
      // linking Facebook to existing accounts would close that, and would break
      // what `scripts/onboard-club.ts` tells every club owner — that the account
      // made for them is "linked when they first sign in with Google or
      // Facebook as this address".

      // Upsert, not find-then-create: two tabs racing a first sign-in would
      // otherwise both miss and one would die on the unique constraint.
      //
      // `update: {}` is deliberate. Re-running this on every sign-in would let
      // the provider overwrite a name or avatar the person has since changed in
      // the app, silently, on each login.
      const row = await runAsSuperuser((db) =>
        db.user.upsert({
          where: { email },
          create: {
            email,
            name: typeof user.name === 'string' ? user.name : null,
            avatarUrl: typeof user.image === 'string' ? user.image : null,
            // The provider asserted it, and for Google we just checked it.
            emailVerified: new Date(),
            // A first sign-in holds nothing and has decided nothing: the
            // person is asked "Играч или треньор?" before anything else
            // (#360, Q13), and `/start` sends an undecided account to that
            // question. Stated rather than left to the column default
            // (PLAYER, which scripts and the previous image still rely on),
            // because it is a decision. A staff invite or being made an owner
            // still turns an EMPTY undecided account into a CLUB account
            // (`account-kind.ts`), as it did an empty player.
            accountKind: null,
          },
          update: {},
          select: { id: true, avatarUrl: true },
        }),
      );

      // ═══ A FACEBOOK PICTURE IS RE-READ AT EVERY FACEBOOK SIGN-IN ═══
      //
      // `update: {}` keeps what the account's first sign-in wrote, and a
      // Facebook picture cannot be kept like that: it is a signed URL that
      // expires (`@/lib/auth/facebook`). So a Facebook sign-in replaces a
      // stored Facebook picture, or nothing, with the one it just brought —
      // never a picture from anywhere else. Between sign-ins an expired one
      // fails to load, and `InitialsAvatar` shows the initials underneath.
      //
      // Contained: an avatar is not worth failing a sign-in over.
      if (account.provider === 'facebook') {
        const fresh = typeof user.image === 'string' ? user.image : null;
        if (fresh !== row.avatarUrl && facebookRefreshesAvatar(row.avatarUrl)) {
          try {
            await runAsSuperuser((db) =>
              db.user.update({ where: { id: row.id }, data: { avatarUrl: fresh } }),
            );
          } catch (error) {
            logger.warn('facebook sign-in: the picture was not refreshed', {
              component: 'auth',
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
      }

      // The rest of the chain reads this object: `token.sub`, the membership
      // lookup, and the user_session foreign key all come from it.
      user.id = row.id;
      user.email = email;
      return true;
    },

    async jwt({ token, user, trigger }) {
      if (user?.id) {
        const rows = await runAsSuperuser((db) =>
          db.tenantMembership.findMany({
            where: { userId: user.id, status: 'ACTIVE' },
            include: { tenant: { select: { id: true, slug: true } } },
            orderBy: { createdAt: 'asc' },
          }),
        );

        const { memberships, membershipsTruncated } = buildMembershipClaims(
          membershipClaimsFrom(rows),
        );

        token.sub = user.id;
        token.memberships = memberships;
        token.membershipsTruncated = membershipsTruncated;

        // The UI language, so middleware can seed the locale cookie without a
        // database read per request. `User.locale` defaults to `bg`, which is
        // also the fallback in src/lib/i18n/locales.ts — so a first sign-in
        // does not change the language under someone mid-session.
        token.locale = await runAsSuperuser((db) =>
          db.user
            .findUnique({ where: { id: user.id }, select: { locale: true } })
            .then((u) => u?.locale ?? DEFAULT_LOCALE),
        );

        // Default to the first membership; the tenant switcher re-mints.
        const first = memberships[0];
        token.tenantId = first?.tenantId ?? null;
        token.tenantSlug = first?.tenantSlug ?? null;
        token.role = first?.role ?? null;
        token.permissions = first ? [...getPermissionsForRole(first.role as never)] : [];

        // ═══ RECORD THE SESSION SO IT CAN BE TAKEN BACK ═══
        //
        // `user` is present only on SIGN-IN. This callback also runs on every
        // session poll, and creating a row there would mint a new session on
        // every page focus — thousands of rows per user, and a "sign out
        // everywhere" that misses the ones created since.
        //
        // sessionVersion is snapshotted from the user's CURRENT counter. When
        // a password change increments that counter, every token carrying an
        // older value stops being accepted — including tokens we have never
        // seen, held by instances that have since died.
        //
        // If this write fails, sign-in fails. That is the intended direction:
        // a session that cannot be revoked is worse than a sign-in that has
        // to be retried.
        const sessionSecret = newSessionSecret();
        const created = await createUserSession({
          userId: user.id,
          // NULL until a tenant is selected. `user_session`'s WITH CHECK
          // rejects a tenant that is not the bound one, which is why this
          // whole path runs as superuser.
          tenantId: null,
          sessionSecret,
          expiresAt: new Date(Date.now() + SESSION_MAX_AGE_SECONDS * 1000),
        });

        token.userSessionId = created.userSessionId;
        token.sessionVersion = created.sessionVersion;
        token.sessionSecret = sessionSecret;
      }

      // ═══ A LANGUAGE CHANGE REACHES THE TOKEN (#362) ═══
      //
      // The middleware re-seeds the locale cookie from `token.locale` whenever
      // the two differ, and the token was minted at sign-in. So a language the
      // profile page saved to `User.locale` would be flipped straight back on
      // the next request, by a token that still carried the old one. After
      // saving, the page POSTs to /api/auth/session (next-auth's CSRF-checked
      // update), which arrives here as `trigger: 'update'`.
      //
      // The new value is READ FROM THE DATABASE, never taken from the request
      // body: an update can only make the token agree with the user's own row.
      //
      // The DISPLAY NAME rides the same refresh (#359): the header and the
      // account menu read `token.name`, so a name set on /me/profile would
      // otherwise show only after the next sign-in. Same rule: read from the
      // user's own row, never from the request. Nothing else changes here.
      if (trigger === 'update' && !user && token.sub) {
        const row = await runAsSuperuser((db) =>
          db.user.findUnique({ where: { id: token.sub }, select: { locale: true, name: true } }),
        );
        if (row) {
          token.locale = row.locale;
          token.name = row.name;
        }
      }

      return token;
    },

    async session({ session, token }) {
      // Mirror the JWT onto the session so a client component sees the same
      // claims the token carries.
      //
      // ═══ `role` AND `permissions` ARE DISPLAY-ONLY. DO NOT AUTHORISE ON
      //     THEM. ═══
      //
      // They are derived from `memberships[0]` above — the club this user
      // joined FIRST, which has nothing to do with the club any given request
      // is about. Reading them to decide whether an action is allowed is
      // cross-tenant privilege escalation: an OWNER at one club would pass an
      // owner-only check at every other club they had merely joined. The
      // middleware used to do exactly that.
      //
      // Both authoritative paths derive permissions from the membership
      // matching the tenant being addressed, and neither reads these fields:
      //
      //   edge      `permissionsForPath`   in `@/lib/auth/guard`
      //   routes    `contextFromRequest`   in `@/app/api/v1/_lib/context`
      //
      // `token-permissions-are-not-authorisation` fails the build if anything
      // else starts reading them.
      //
      // `memberships` is the honest field: it says which club grants which
      // role, so a UI that wants to know whether to draw an admin button can
      // look up the club it is actually drawing.
      return Object.assign(session, {
        userId: token.sub,
        tenantId: token.tenantId,
        tenantSlug: token.tenantSlug,
        role: token.role,
        permissions: token.permissions,
        memberships: token.memberships,
        membershipsTruncated: token.membershipsTruncated,
      });
    },
  },
};
