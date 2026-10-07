import { notFound, redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';

import { clubResourceNouns } from '@/app-layer/usecases/club-nouns';
import { ClubAdminShell } from '@/components/layout/club-admin-shell';
// NOT from a 'use client' module: the server CALLS this, and every export of
// a client module is a client reference that throws when called (#195-#227).
import { clubShell } from '@/components/layout/nav-items';
import { resolveTenantPageContext, signedInIdentity } from '@/lib/auth/page-context';
import { resolvePlatformAuthority } from '@/lib/auth/platform-admin';

/**
 * The club-admin shell: sidebar on a desktop, a left drawer on a phone (T19).
 *
 * ═══ THE NAV IS FILTERED HERE, ON THE SERVER ═══
 *
 * The items are kept or dropped by the permissions of the membership that
 * matches THIS slug, read from the database (`resolveTenantPageContext`), never
 * the token's. The client receives only the links it may show, with their
 * labels translated, and no permission names. Hiding a link is still a
 * courtesy: every page and Server Action authorises itself.
 *
 * A member whose role opens none of the admin pages (a PLAYER membership)
 * gets a 404, the same answer a stranger gets: there is nothing here for them,
 * and an empty shell would say "this club exists and you are in it".
 *
 * ═══ ONE CLUB, NO SWITCHER (#263) ═══
 *
 * A CLUB account holds exactly one club, so the top bar names it and offers
 * nothing to switch to.
 *
 * The two context reads are request-cached and run together: the membership
 * (one indexed query, shared with the club layout above and the page below)
 * and the identity (the token's name and email, for the account menu).
 *
 * ═══ THE WAY OUT, AND THE PHONE BAR (#362, #347) ═══
 *
 * The account rows are decided here: the public site (the club's own page,
 * `/clubs/{slug}`, #356), the profile, and for a holder of a live platform grant the
 * platform (one indexed probe, the read the platform layout makes). Both reads
 * run alongside the membership read, not after it. Below `md` the shell adds the bottom tab bar,
 * resolved from the same `sections`, so a role sees only tabs it may open.
 *
 * ═══ ONE BUILDER FOR THE CLUB'S FRAME (#362) ═══
 *
 * `clubShell` builds the sections and the rows. `PlayerChrome` calls the same
 * builder for a CLUB account on a public page, so the account wears one
 * sidebar everywhere (owner, 2026-10-07). The courts screen's item is named
 * after what the club plays on, "Писти" at a karting club (`clubResourceNouns`,
 * one small read in the club's own context).
 */
export default async function ClubAdminLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const [result, me, t, grant] = await Promise.all([
    resolveTenantPageContext(slug),
    signedInIdentity(),
    getTranslations('common.nav'),
    // The same live-grant read the platform layout makes (#345), beside the
    // others rather than after them: hiding only, and never a throw.
    // `signedInIdentity` is request-cached, so asking twice is one read.
    signedInIdentity().then((who) => (who ? resolvePlatformAuthority(who.userId) : null)),
  ]);

  // The club layout above already answered both of these. A layout and its
  // child layout render concurrently, so this one does not trust that it ran.
  if (result.kind === 'unauthenticated' || !me) {
    redirect(`/login?next=${encodeURIComponent(`/t/${slug}`)}`);
  }
  if (result.kind === 'not-a-member') notFound();

  const nouns = await clubResourceNouns(result.ctx.tenantId);
  const club = clubShell(result.ctx, { platform: grant?.capabilities ?? [], t, nouns });
  if (club.sections.length === 0) notFound();

  return (
    <ClubAdminShell
      sections={club.sections}
      homeHref={club.homeHref}
      contextName={club.contextName}
      user={{ name: me.name, email: me.email }}
      account={club.account}
      bottomTabs
      fullBleedSegment="calendar"
    >
      {children}
    </ClubAdminShell>
  );
}
