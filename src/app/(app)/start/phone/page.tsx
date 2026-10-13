import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';

import { resolveLanding } from '@/app-layer/usecases/landing';
import { phoneStanding } from '@/app-layer/usecases/phone-verification';
import { SignOutButton } from '@/components/layout/SignOutButton';
import { Caption, Heading } from '@/components/ui/typography';
import { phoneStepHref, safeCallbackPath } from '@/lib/auth/landing';
import { requireSignedIn } from '@/lib/auth/page-context';
import { ViewerScope } from '@/lib/data/provider';

import { PhoneLater, PhoneStep, PhoneStepDone } from './PhoneStep';

export async function generateMetadata() {
  const t = await getTranslations('phone.step');
  return { title: t('metaTitle') };
}

/**
 * /start/phone: confirm a phone number by SMS code (#500; owner decisions
 * 2026-10-13).
 *
 * A player or coach confirms a number before their first booking, join
 * request or message. Two ways here, each with `next` (where the person was,
 * checked by `safeCallbackPath`):
 *
 *   - a screen that was refused for it (403 PHONE_REQUIRED);
 *   - the middleware, once after signing in, while the session token says the
 *     account is still to be asked (src/lib/auth/phone-ask.ts).
 *
 * The token is a hint, so this page asks the database. An account that has a
 * number already, or is not one the rule is for, is asked nothing: its
 * session is refreshed and it goes on.
 *
 * It says what the number is for and who sees it. «Не сега» goes on without
 * confirming and is remembered in that browser, so the ask is not repeated:
 * browsing needs no number, and whatever needs one offers this step itself.
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

  // Nothing to ask: a number is confirmed already, or this is not an account
  // the rule is for (a club's, or one that has not chosen its kind). The
  // middleware sent it here from a session token that did not know, so the
  // session is refreshed and it goes on. Not a redirect: with the same stale
  // token, the next page would send it straight back.
  if (standing.verified || !standing.applies) {
    return (
      <main className="bg-bg-page text-content-default safe-area-x flex flex-1 flex-col">
        <div className="gap-section mx-auto flex w-full max-w-md flex-1 flex-col px-4 py-10 md:px-6 md:py-16">
          <PhoneStepDone to={onward} />
        </div>
      </main>
    );
  }

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
          <PhoneLater to={onward} />
          <SignOutButton />
        </div>
      </div>
    </main>
  );
}
