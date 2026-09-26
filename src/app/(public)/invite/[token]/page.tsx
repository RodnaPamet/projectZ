import { getTranslations } from 'next-intl/server';
import Link from 'next/link';

import { previewInvite } from '@/app-layer/usecases/invites';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { requireSignedIn } from '@/lib/auth/page-context';
import { runAsSuperuser } from '@/lib/db/rls-middleware';

import { acceptInviteAction } from './actions';

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
      <main className="bg-bg-page text-content-default safe-area-top safe-area-x min-h-screen px-6 py-16">
        <div className="mx-auto max-w-md">
          <EmptyState title={t('invalid.title')} description={t('invalid.description')} />
        </div>
      </main>
    );
  }

  const userId = await requireSignedIn();

  return (
    <main className="bg-bg-page text-content-default safe-area-top safe-area-x min-h-screen px-6 py-16">
      <div className="mx-auto max-w-md">
        <h1 className="text-2xl font-semibold">{t('title', { club: preview.tenantName })}</h1>
        <p className="text-content-muted mt-2">
          {t('asRole', { role: t(`role.${preview.role}`) })}
        </p>
        <p className="text-content-muted mt-1 text-sm">{t('sentTo', { email: preview.email })}</p>

        {userId ? (
          <form
            action={async () => {
              'use server';
              await acceptInviteAction(token);
            }}
            className="mt-6"
          >
            <Button type="submit">{t('accept')}</Button>
          </form>
        ) : (
          <div className="mt-6">
            {/* `next` carries the token back, so signing in does not lose the
                invite — the commonest way an invite flow strands somebody. */}
            <Link
              href={`/login?next=${encodeURIComponent(`/invite/${token}`)}`}
              className="bg-bg-brand text-content-on-brand inline-flex h-10 items-center rounded-md px-4 text-sm font-medium"
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
