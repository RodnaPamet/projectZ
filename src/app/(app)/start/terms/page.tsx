import { redirect } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';

import { resolveLanding } from '@/app-layer/usecases/landing';
import { legalStanding } from '@/app-layer/usecases/legal-acceptance';
import { SignOutButton } from '@/components/layout/SignOutButton';
import { Card } from '@/components/ui/card';
import { Caption, Heading, TextLink } from '@/components/ui/typography';
import { safeCallbackPath } from '@/lib/auth/landing';
import { requireSignedIn } from '@/lib/auth/page-context';
import { ViewerScope } from '@/lib/data/provider';
import { DEFAULT_LOCALE, isLocale } from '@/lib/i18n/locales';
import { legalHrefs } from '@/lib/legal/texts';
import { LEGAL_STEP_PATH } from '@/lib/legal/versions';

import { AcceptLegal, LegalStepDone } from './LegalStep';

export async function generateMetadata() {
  const t = await getTranslations('onboarding.terms');
  return { title: t('metaTitle') };
}

/**
 * /start/terms: accept the terms and the privacy policy in force (#462; owner
 * decision 2026-10-13: a new version asks signed-in people once).
 *
 * The middleware sends an account here when its session token does not hold
 * the versions in force (src/lib/auth/owed-step.ts). The token is a hint, so
 * THIS page asks the database:
 *
 *   something is due    the texts, each linked, and «Приемам»
 *   nothing is due      the token was stale (accepted in another browser, or
 *                       minted before the acceptance was recorded): the
 *                       session is refreshed and the person goes on, having
 *                       been asked nothing
 *
 * Either way they continue to `next`, a path on this site checked by
 * `safeCallbackPath`, else where the account lands.
 *
 * No player chrome, as `/start/kind`: nothing else is offered until this is
 * answered, except signing out, and the profile, where a person who will not
 * accept can still download their data and delete the account.
 */
export default async function TermsStepPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string | string[] }>;
}) {
  const raw = (await searchParams).next;
  const next = safeCallbackPath(typeof raw === 'string' ? raw : undefined);
  const here = next ? `${LEGAL_STEP_PATH}?next=${encodeURIComponent(next)}` : LEGAL_STEP_PATH;

  const userId = await requireSignedIn();
  if (!userId) redirect(`/login?next=${encodeURIComponent(here)}`);

  const [standing, t, locale] = await Promise.all([
    legalStanding(userId),
    getTranslations('onboarding.terms'),
    getLocale(),
  ]);
  const onward = next ?? (await resolveLanding(userId)).href;

  if (standing.due.length === 0) {
    return (
      <main className="bg-bg-page text-content-default safe-area-x flex flex-1 flex-col">
        <div className="gap-section mx-auto flex w-full max-w-md flex-1 flex-col px-4 py-10 md:px-6 md:py-16">
          <LegalStepDone to={onward} />
        </div>
      </main>
    );
  }

  const hrefs = await legalHrefs(isLocale(locale) ? locale : DEFAULT_LOCALE);

  return (
    <main className="bg-bg-page text-content-default safe-area-x flex flex-1 flex-col">
      <div className="gap-section mx-auto flex w-full max-w-md flex-1 flex-col px-4 py-10 md:px-6 md:py-16">
        <div className="gap-tight flex flex-col">
          <Heading level={1}>{t('title')}</Heading>
          <p className="text-content-muted text-sm">{t('description')}</p>
        </div>

        <Card elevation="flat" density="none">
          <ul className="divide-border-subtle divide-y" data-testid="legal-due">
            {standing.due.map((doc) => {
              const href = hrefs[doc];
              return (
                <li
                  key={doc}
                  className="flex min-h-14 items-center justify-between gap-3 px-4 py-3"
                >
                  {href ? (
                    // A new tab: the step stays where it is while they read.
                    <TextLink tone="link" href={href} target="_blank" rel="noopener">
                      {t(`document.${doc}`)}
                    </TextLink>
                  ) : (
                    <span className="text-content-emphasis font-medium">
                      {t(`document.${doc}`)}
                    </span>
                  )}
                  <Caption className="shrink-0">
                    {t('version', { version: standing.current[doc] ?? '' })}
                  </Caption>
                </li>
              );
            })}
          </ul>
        </Card>

        <ViewerScope viewerId={userId}>
          <AcceptLegal to={onward} />
        </ViewerScope>

        <Caption data-testid="legal-decline">
          {t.rich('decline', {
            profile: (chunks) => (
              <TextLink tone="link" href="/me/profile">
                {chunks}
              </TextLink>
            ),
          })}
        </Caption>
        <div className="mt-auto">
          <SignOutButton />
        </div>
      </div>
    </main>
  );
}
