import { redirect } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';

import { readMyAccountKind } from '@/app-layer/usecases/account-kind';
import { resolveLanding } from '@/app-layer/usecases/landing';
import { SignOutButton } from '@/components/layout/SignOutButton';
import { Caption, Heading, TextLink } from '@/components/ui/typography';
import { requireSignedIn } from '@/lib/auth/page-context';
import { KIND_CHOOSER_PATH, safeCallbackPath } from '@/lib/auth/landing';
import { ViewerScope } from '@/lib/data/provider';
import { DEFAULT_LOCALE, isLocale } from '@/lib/i18n/locales';
import { legalHrefs } from '@/lib/legal/texts';

import { KindChooser } from './KindChooser';

export async function generateMetadata() {
  const t = await getTranslations('onboarding.kind');
  return { title: t('metaTitle') };
}

/**
 * /start/kind: "Играч или треньор?" (#360, Q13, audit U01).
 *
 * A new account is NULL until it answers, and `/start` sends it here before
 * anything else (`decideLanding`), instead of to an empty bookings page with
 * no explanation. Clubs are created by the owner, so CLUB is not offered.
 *
 * The choice is made once (`POST /api/v1/me/account-kind`, a compare-and-set
 * on NULL). An account that already has a kind never sees this page: it is
 * sent on to `next` or where it lands. `next` is a path on this site, checked
 * by `safeCallbackPath` like `/login`'s, so the booking invite page can send
 * an undecided visitor here and get them back.
 *
 * No player chrome: nothing else is offered until this is answered, except
 * signing out.
 */
export default async function KindChooserPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string | string[] }>;
}) {
  const raw = (await searchParams).next;
  const next = safeCallbackPath(typeof raw === 'string' ? raw : undefined);
  const here = next ? `${KIND_CHOOSER_PATH}?next=${encodeURIComponent(next)}` : KIND_CHOOSER_PATH;

  const userId = await requireSignedIn();
  if (!userId) redirect(`/login?next=${encodeURIComponent(here)}`);

  const kind = await readMyAccountKind(userId);
  if (kind === undefined) redirect('/login');
  if (kind !== null) redirect(next ?? (await resolveLanding(userId)).href);

  const [t, locale] = await Promise.all([getTranslations('onboarding.kind'), getLocale()]);
  // "Продължавайки, приемате …" (#370): only when both texts exist in this
  // language, since the sentence links to both. Recording the acceptance is
  // #462; this is the notice.
  const legal = await legalHrefs(isLocale(locale) ? locale : DEFAULT_LOCALE);
  const terms = legal.terms;
  const privacy = legal.privacy;

  return (
    <main className="bg-bg-page text-content-default safe-area-x flex flex-1 flex-col">
      <div className="gap-section mx-auto flex w-full max-w-md flex-1 flex-col px-4 py-10 md:px-6 md:py-16">
        <div className="gap-tight flex flex-col">
          <Heading level={1}>{t('title')}</Heading>
          <p className="text-content-muted text-sm">{t('description')}</p>
        </div>
        <ViewerScope viewerId={userId}>
          <KindChooser next={next} />
        </ViewerScope>
        {terms && privacy ? (
          <Caption data-testid="kind-consent">
            {t.rich('consent', {
              terms: (chunks) => (
                <TextLink tone="link" href={terms}>
                  {chunks}
                </TextLink>
              ),
              privacy: (chunks) => (
                <TextLink tone="link" href={privacy}>
                  {chunks}
                </TextLink>
              ),
            })}
          </Caption>
        ) : null}
        <div className="mt-auto">
          <SignOutButton />
        </div>
      </div>
    </main>
  );
}
