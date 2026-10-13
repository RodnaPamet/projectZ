import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';

import { resolveLanding } from '@/app-layer/usecases/landing';
import { phoneStanding } from '@/app-layer/usecases/phone-verification';
import { SignOutButton } from '@/components/layout/SignOutButton';
import { buttonVariants } from '@/components/ui/button-variants';
import { Caption, Heading } from '@/components/ui/typography';
import { phoneStepHref, safeCallbackPath } from '@/lib/auth/landing';
import { requireSignedIn } from '@/lib/auth/page-context';
import { ViewerScope } from '@/lib/data/provider';

import { PhoneStep } from './PhoneStep';

export async function generateMetadata() {
  const t = await getTranslations('phone.step');
  return { title: t('metaTitle') };
}

/**
 * /start/phone: confirm a phone number by SMS code (#500; owner decisions
 * 2026-10-13).
 *
 * A player or coach confirms a number before their first booking, join
 * request or message. A screen that was refused for it (403 PHONE_REQUIRED)
 * sends the person here, with `next`: where they were, checked by
 * `safeCallbackPath`. An account that has confirmed one already never sees
 * the step: it is sent on.
 *
 * It says what the number is for and who sees it (nobody). «Не сега» goes
 * back without confirming: browsing needs no number, and whatever needed one
 * will ask again.
 *
 * No player chrome, as the other `/start` steps.
 */
export default async function PhoneStepPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string | string[] }>;
}) {
  const raw = (await searchParams).next;
  const next = safeCallbackPath(typeof raw === 'string' ? raw : undefined);

  const userId = await requireSignedIn();
  if (!userId) redirect(`/login?next=${encodeURIComponent(phoneStepHref(next))}`);

  const [standing, t] = await Promise.all([phoneStanding(userId), getTranslations('phone.step')]);
  if (!standing) redirect('/login');
  const onward = next ?? (await resolveLanding(userId)).href;
  if (standing.verified) redirect(onward);

  return (
    <main className="bg-bg-page text-content-default safe-area-x flex flex-1 flex-col">
      <div className="gap-section mx-auto flex w-full max-w-md flex-1 flex-col px-4 py-10 md:px-6 md:py-16">
        <div className="gap-tight flex flex-col">
          <Heading level={1}>{t('title')}</Heading>
          <p className="text-content-muted text-sm">{t('description')}</p>
        </div>
        <ViewerScope viewerId={userId}>
          <PhoneStep to={onward} />
        </ViewerScope>
        <Caption data-testid="phone-privacy">{t('privacy')}</Caption>
        <div className="mt-auto flex flex-wrap items-center justify-between gap-3">
          <Link
            href={onward}
            className={buttonVariants({ variant: 'ghost' })}
            data-testid="phone-later"
          >
            {t('later')}
          </Link>
          <SignOutButton />
        </div>
      </div>
    </main>
  );
}
