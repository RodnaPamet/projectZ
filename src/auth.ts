import { PrismaAdapter } from '@auth/prisma-adapter';
import type { NextAuthOptions } from 'next-auth';
import CredentialsProvider from 'next-auth/providers/credentials';
import GoogleProvider from 'next-auth/providers/google';

import { buildMembershipClaims, type MembershipClaim } from '@/lib/auth/jwt-claims';
import { createUserSession, newSessionSecret, SESSION_MAX_AGE_SECONDS } from '@/lib/auth/sessions';
import { verifyCredentials } from '@/lib/auth/verify-credentials';
import { getPermissionsForRole } from '@/lib/permissions';
import { prisma } from '@/lib/db/prisma';
import { runAsSuperuser } from '@/lib/db/rls-middleware';

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
    async jwt({ token, user }) {
      if (user?.id) {
        const rows = await runAsSuperuser((db) =>
          db.tenantMembership.findMany({
            where: { userId: user.id, status: 'ACTIVE' },
            include: { tenant: { select: { id: true, slug: true } } },
            orderBy: { createdAt: 'asc' },
          }),
        );

        const all: MembershipClaim[] = rows.map((m) => ({
          tenantId: m.tenant.id,
          tenantSlug: m.tenant.slug,
          role: m.role,
        }));

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
