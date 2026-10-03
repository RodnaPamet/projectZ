import { getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { redirect } from 'next/navigation';

import { inviteAcceptanceFor, previewInvite } from '@/app-layer/usecases/invites';
import { Button } from '@/components/ui/button';
import { buttonVariants } from '@/components/ui/button-variants';
import { EmptyState } from '@/components/ui/empty-state';
import { Heading } from '@/components/ui/typography';
import { requireSignedIn } from '@/lib/auth/page-context';
import { runAsSuperuser } from '@/lib/db/rls-middleware';

import { acceptInviteAction } from './actions';
import { InviteRefusal } from './InviteRefusal';

export async function generateMetadata() {
  const t = await getTranslations('invite');
  return { title: t('metaTitle') };
}

/**
 * The page the edge carve-out has been pointing at since P07.
 *
 * `guard.ts` has always listed `/invite/[^/]+` as an invite carve-out —
 * deliberately reachable while signed out — and there was no page behind it
 * (#199). This is it.
 *
 * ═══ SIGNED OUT IS THE NORMAL CASE ═══
 *
 * Most invitees have no account yet. So the page renders the offer first —
 * which club, which role — and only then asks them to sign in, carrying
 * `?next=` back to this URL so the token is not lost on the round trip.
 *
 * Showing the offer before the sign-in wall is what makes it credible: a bare
 * login screen reached from an email link is indistinguishable from phishing.
 *
 * ═══ ONE MESSAGE FOR EVERY UNUSABLE TOKEN ═══
 *
 * Expired, revoked, already accepted and never-existed all render the same
 * thing. Telling them apart would let somebody probe for live tokens, and the
 * distinction helps a legitimate visitor not at all — in every case the answer
 * is "ask the club for another".
 *
 * ═══ THE WRONG ACCOUNT IS SAID PLAINLY (#263) ═══
 *
 * One account is one kind: a staff invite needs a club account with no club
 * yet, or a brand-new one; a player invite needs a player. A signed-in visitor
 * whose account does not fit is told BEFORE the button, not after it — with
 * what to do: sign out and come back with another account. The sign-out
 * returns to the sign-in page with this link as `next`, so switching accounts
 * does not lose the invitation. `acceptInvite` enforces the same rule; if it
 * refuses after the click — a second invitation accepted meanwhile — the page
 * is simply rendered again, and asks again.
 */
export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const t = await getTranslations('invite');

  // Superuser: the point of the lookup is to discover which tenant the token
  // belongs to, so there is nothing to bind to yet. By a hash of a secret the
  // visitor supplied — it cannot enumerate.
  const preview = await runAsSuperuser((db) => previewInvite(db, token));

  if (!preview) {
    return (
      <main className="bg-bg-page text-content-default safe-area-x flex-1 px-6 py-16">
        <div className="mx-auto max-w-md">
          <EmptyState title={t('invalid.title')} description={t('invalid.description')} />
        </div>
      </main>
    );
  }

  const userId = await requireSignedIn();

  // Asked before the button is offered. What else the account holds spans
  // every club — the same BYPASSRLS read, scoped to the signed-in user.
  const fit = userId
    ? await runAsSuperuser((db) => inviteAcceptanceFor(db, preview, userId))
    : null;
  const refusal = fit && !fit.ok ? fit.refusal : null;

  const here = `/invite/${encodeURIComponent(token)}`;

  return (
    <main className="bg-bg-page text-content-default safe-area-x flex-1 px-6 py-16">
      <div className="mx-auto max-w-md">
        <Heading level={1}>{t('title', { club: preview.tenantName })}</Heading>
        <p className="text-content-muted mt-2">
          {t('asRole', { role: t(`role.${preview.role}`) })}
        </p>
        <p className="text-content-muted mt-1 text-sm">{t('sentTo', { email: preview.email })}</p>

        {userId && refusal ? (
          <InviteRefusal refusal={refusal} invitePath={here} />
        ) : userId ? (
          <form
            action={async () => {
              'use server';
              // Success redirects inside the action. Returning at all is a
              // refusal, and this page — asked again — is what explains it.
              await acceptInviteAction(token);
              redirect(here);
            }}
            className="mt-6"
          >
            <Button type="submit">{t('accept')}</Button>
          </form>
        ) : (
          <div className="mt-6">
            {/* `next` carries the token back, so signing in does not lose the
                invite — the commonest way an invite flow strands somebody.
                The primary button's recipe rather than the #245 alias classes,
                so it is the same object as the Accept button it leads to.
                Default (auto) prefetch: a query-string link, which the
                router-cache policy leaves on auto (docs/perf/navigation-policy.md),
                and the one full-prefetch /login link is the header's. */}
            <Link
              href={`/login?next=${encodeURIComponent(here)}`}
              className={buttonVariants({ variant: 'primary' })}
            >
              {t('signInToAccept')}
            </Link>
            <p className="text-content-muted mt-2 text-sm">{t('signInNote')}</p>
          </div>
        )}
      </div>
    </main>
  );
}
