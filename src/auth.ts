import { PrismaAdapter } from '@auth/prisma-adapter';
import type { NextAuthOptions } from 'next-auth';
import CredentialsProvider from 'next-auth/providers/credentials';
import AzureADProvider from 'next-auth/providers/azure-ad';
import GoogleProvider from 'next-auth/providers/google';

import { buildMembershipClaims, type MembershipClaim } from '@/lib/auth/jwt-claims';
import { createUserSession, newSessionSecret, SESSION_MAX_AGE_SECONDS } from '@/lib/auth/sessions';
import { verifyCredentials } from '@/lib/auth/verify-credentials';
import { getPermissionsForRole } from '@/lib/permissions';
import { prisma } from '@/lib/db/prisma';
import { runAsSuperuser } from '@/lib/db/rls-middleware';
import { logger } from '@/lib/observability/logger';

/**
 * NextAuth v4.
 *
 * Sign-in runs as app_superuser: at this point no tenant is selected, so
 * there is no `app.tenant_id` to bind, and an RLS-scoped query for the User
 * would return zero rows and look exactly like "wrong password".
 */
// Defined in lib/auth/sessions so that reading it does not pull authOptions
// (and PrismaAdapter) into a bundle. Re-exported because callers expect it here.
export { SESSION_MAX_AGE_SECONDS } from '@/lib/auth/sessions';

export const authOptions: NextAuthOptions = {
  adapter: PrismaAdapter(prisma) as NextAuthOptions['adapter'],
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

  providers: [
    GoogleProvider({
      clientId: process.env.GOOGLE_CLIENT_ID ?? '',
      clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? '',
    }),

    /**
     * Microsoft Entra ID.
     *
     * ═══ THE PROVIDER ID IS `azure-ad`, NOT `microsoft-entra-id` ═══
     *
     * next-auth v4 ships this as `providers/azure-ad` with id `azure-ad`.
     * `microsoft-entra-id` is the Auth.js **v5** name, and it appears in
     * comments elsewhere in this repo that were written against v5. Anything
     * keyed on that literal — a provider check, a metric label, a callback URL
     * — silently never matches, which is the worst kind of wrong: no error,
     * just a feature that never runs.
     *
     * The callback URL is therefore /api/auth/callback/azure-ad, and that is
     * what goes in the app registration.
     *
     * ═══ THE SCOPE BUYS THE OVERAGE PATH, NOT THE CLAIM ═══
     *
     * `GroupMember.Read.All` lets us ask Graph for the group list when Entra
     * omits it for size. It does NOT cause the `groups` claim to be issued —
     * that is governed by the customer's own app-registration token
     * configuration. A club that has not configured it gets no claim, and
     * asking for a broader scope will not change that.
     */
    AzureADProvider({
      clientId: process.env.MICROSOFT_CLIENT_ID ?? '',
      clientSecret: process.env.MICROSOFT_CLIENT_SECRET ?? '',
      tenantId: process.env.MICROSOFT_TENANT_ID ?? 'common',
      authorization: {
        params: {
          scope:
            'openid email profile offline_access https://graph.microsoft.com/GroupMember.Read.All',
        },
      },

      /**
       * ═══ THIS OVERRIDE EXISTS TO REMOVE A GRAPH CALL, NOT TO ADD ONE ═══
       *
       * next-auth v4's default `profile()` for this provider fetches the
       * user's avatar from `graph.microsoft.com/v1.0/me/photos/...` with NO
       * timeout, NO abort signal, and no catch around the fetch itself — its
       * only try/catch sits inside the `response.ok` branch, so a rejected
       * fetch propagates straight out.
       *
       * That call runs during the OAuth callback, in `getProfile`, BEFORE the
       * jwt callback. So every bound in `entra-graph.ts` — the request
       * timeout, the total budget, the retries — is irrelevant to it. Two
       * consequences, both verified against the installed package:
       *
       *   - if Graph is unreachable, next-auth swallows the rejection and
       *     returns no profile, and the user is redirected back to /login with
       *     NO error code. Silently, on every attempt, for as long as the
       *     outage lasts.
       *   - if Graph hangs, node's fetch waits on its default headers timeout,
       *     which is five minutes.
       *
       * An avatar is not worth making Microsoft Graph a hard dependency of
       * authentication. If profile pictures are wanted later they belong in a
       * background job, where being slow or failing costs nobody a login.
       */
      profile(profile: Record<string, unknown>) {
        // `email` is absent for some B2B guest accounts; `preferred_username`
        // carries it there. `upn` is deliberately not used — it is a directory
        // identifier that is not always routable as an address.
        const email =
          (typeof profile.email === 'string' && profile.email) ||
          (typeof profile.preferred_username === 'string' && profile.preferred_username) ||
          null;

        return {
          id: String(profile.sub ?? profile.oid ?? ''),
          name: typeof profile.name === 'string' ? profile.name : null,
          email,
          image: null,
        };
      },
    }),

    CredentialsProvider({
      name: 'credentials',
      credentials: {
        email: { label: 'Email', type: 'email' },
        password: { label: 'Password', type: 'password' },
      },

      async authorize(credentials) {
        // Shared with the native token endpoint, deliberately. The
        // enumeration defence (equal bcrypt time on every failure path) lives
        // in ONE place; two copies is how one of them loses it.
        return verifyCredentials(credentials?.email, credentials?.password);
      },
    }),
  ],

  callbacks: {
    async jwt({ token, user, account, profile }) {
      if (user?.id) {
        const rows = await runAsSuperuser((db) =>
          db.tenantMembership.findMany({
            where: { userId: user.id, status: 'ACTIVE' },
            include: { tenant: { select: { id: true, slug: true } } },
            orderBy: { createdAt: 'asc' },
          }),
        );

        let all: MembershipClaim[] = rows.map((m) => ({
          tenantId: m.tenant.id,
          tenantSlug: m.tenant.slug,
          role: m.role,
        }));

        // ═══ ENTRA GROUP SYNC ═══
        //
        // Only on an Entra sign-in. Gating on the provider matters: without
        // it, a Google or password sign-in would also reach for Microsoft
        // Graph, making Graph availability a dependency of logins that have
        // nothing to do with Microsoft.
        //
        // The provider id is `azure-ad` because this is next-auth v4.
        // `microsoft-entra-id` is the Auth.js v5 name and appears in older
        // comments in this repo; a check against that literal would never
        // match and the whole feature would silently never run.
        if (account?.provider === 'azure-ad' && all.length > 0) {
          // ═══ EVERYTHING HERE IS CONTAINED ═══
          //
          // Role sync is advisory: it decides what role you hold, never
          // whether you may sign in. Letting a Prisma error, a Graph hiccup or
          // a bad config row escape into this callback would fail the LOGIN —
          // turning an optional convenience into a hard dependency, and
          // producing a blank redirect back to /login with no explanation.
          //
          // The failure mode on catch is "you signed in with the role you
          // already had", which is exactly the state the user was in a moment
          // ago.
          try {
            const { syncEntraMembershipRole } = await import('@/lib/auth/entra-group-sync');

            // Which of this user's clubs actually federate with Entra?
            //
            // Derived from PROVIDER rows, not from mappings. Deriving it from
            // mappings meant a gated club with zero mappings was never
            // evaluated at all — the gate silently stopped applying at the
            // moment somebody deleted the last mapping.
            const configured = await runAsSuperuser((db) =>
              db.tenantIdentityProvider.findMany({
                where: {
                  tenantId: { in: all.map((m) => m.tenantId) },
                  type: 'ENTRA_ID',
                  enabled: true,
                },
                select: { tenantId: true },
                orderBy: { tenantId: 'asc' },
                take: 50,
              }),
            );

            // Graph is consulted only if some club will actually use the
            // answer. Resolving claims first meant a user whose clubs do not
            // federate still paid for a paginated, retrying Graph fetch whose
            // result was then discarded.
            if (configured.length > 0) {
              const { resolveEntraGroupClaims } = await import('@/lib/auth/entra-group-claims');

              const claims = await resolveEntraGroupClaims({
                profile,
                accessToken: account.access_token,
              });

              const denied = new Set<string>();
              let anyChanged = false;

              for (const { tenantId } of configured) {
                const result = await runAsSuperuser((db) =>
                  syncEntraMembershipRole(db, { userId: user.id, tenantId, claims }),
                );
                if (result.gateDenied) denied.add(tenantId);
                if (result.changed) anyChanged = true;
              }

              // A role was written, so the rows read a moment ago are stale.
              // Minting the token from them would hand the user their OLD role
              // for the whole session — the promotion would appear to have
              // done nothing.
              if (anyChanged) {
                const fresh = await runAsSuperuser((db) =>
                  db.tenantMembership.findMany({
                    where: { userId: user.id, status: 'ACTIVE' },
                    include: { tenant: { select: { id: true, slug: true } } },
                    orderBy: { createdAt: 'asc' },
                  }),
                );
                all = fresh.map((m) => ({
                  tenantId: m.tenant.id,
                  tenantSlug: m.tenant.slug,
                  role: m.role,
                }));
              }

              // The gate denies ACCESS, and access in this system is a
              // membership claim: dropping it is what `checkTenantAccess`
              // reads as "not a member". The database row is untouched — the
              // person is still a member, they simply hold no session for it.
              if (denied.size > 0) {
                all = all.filter((m) => !denied.has(m.tenantId));
              }

              token.aadGroupsOverage = claims.overage;
            }
          } catch (error) {
            logger.error('Entra group sync failed; signing in with existing roles', {
              userId: user.id,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        } else if (all.length > 0) {
          // ═══ THE GATE MUST NOT BE BYPASSABLE BY CHOOSING ANOTHER BUTTON ═══
          //
          // `enforceGroupGate` says "you must be in a mapped Entra group to
          // reach this club". Evaluating it only on the Entra path made it
          // trivially avoidable: sign in with a password, or with Google, and
          // the gate never runs. A club that switched it on believed access
          // was restricted, and it was not — which is worse than not having
          // the control, because somebody is relying on it.
          //
          // So at a gated club, a sign-in that cannot prove group membership
          // does not get that club. There is no way to prove it here: the
          // group claim only exists on an Entra token.
          //
          // OWNER is exempt, for the same reason it is exempt in the sync — a
          // configuration mistake must not leave a club with nobody able to
          // get in and correct it.
          try {
            const { readGroupGateFlag } = await import('@/app-layer/schemas/entra-provider');

            const gated = await runAsSuperuser((db) =>
              db.tenantIdentityProvider.findMany({
                where: {
                  tenantId: { in: all.map((m) => m.tenantId) },
                  type: 'ENTRA_ID',
                  enabled: true,
                },
                select: { tenantId: true, configJson: true },
                orderBy: { tenantId: 'asc' },
                take: 50,
              }),
            );

            const enforcing = new Set(
              gated.filter((g) => readGroupGateFlag(g.configJson)).map((g) => g.tenantId),
            );

            if (enforcing.size > 0) {
              all = all.filter((m) => m.role === 'OWNER' || !enforcing.has(m.tenantId));
            }
          } catch (error) {
            // Contained like the branch above — but note the asymmetry: a
            // failure here means the gate is NOT applied for this session.
            // Failing the login instead would let one bad config row lock a
            // club out entirely, so this is logged loudly and left permissive.
            logger.error('Entra group gate check failed; gate not applied this session', {
              userId: user.id,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }

        const { memberships, membershipsTruncated } = buildMembershipClaims(all);

        token.sub = user.id;
        token.memberships = memberships;
        token.membershipsTruncated = membershipsTruncated;

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
