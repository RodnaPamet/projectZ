import type { ReactNode } from 'react';

import { getTranslations } from 'next-intl/server';

import { PROFILE_HREF } from '@/components/layout/nav-items';
import { PageBreadcrumbs } from '@/components/layout/PageBreadcrumbs';
import { Heading, TextLink } from '@/components/ui/typography';
import { CONTACT_FORM_HREF, DELETE_ACCOUNT_HELP_HREF } from '@/lib/account/links';

export async function generateMetadata() {
  const t = await getTranslations('deleteAccountHelp');
  return {
    title: t('metaTitle'),
    description: t('metaDescription'),
    alternates: { canonical: DELETE_ACCOUNT_HELP_HREF },
  };
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="gap-compact flex flex-col">
      <Heading level={2}>{title}</Heading>
      {children}
    </section>
  );
}

const P = 'text-content-default leading-relaxed';
const LIST = 'text-content-default flex flex-col gap-1 pl-6 leading-relaxed';

/**
 * /delete-account (#370, #445): how to delete a playerz.bg account, and what
 * deleting it does. Public, in both languages, linked from the footer
 * whatever the legal texts are doing, and the URL the Meta app gives as its
 * Data Deletion Instructions.
 *
 * This is product help, not a legal text: it says exactly what the code does
 * (src/app-layer/usecases/account-deletion.ts, src/lib/account/deletion-plan.ts),
 * so a change to either is a change to this page's copy too.
 *
 * Facebook's data-deletion CALLBACK is deliberately not built: removing the
 * app in Facebook's settings could not honour "cancel your upcoming bookings
 * first". The page says that removing the app does not delete the account.
 */
export default async function DeleteAccountHelpPage() {
  const t = await getTranslations('deleteAccountHelp');

  return (
    <>
      {/* One crumb, the page itself: the top bar shows it from md. */}
      <PageBreadcrumbs items={[{ label: t('title') }]} className="hidden" />
      <article
        className="in-shell:p-0 gap-section mx-auto flex w-full max-w-3xl flex-1 flex-col px-4 py-8 md:px-6 md:py-12"
        data-testid="delete-account-help"
      >
        <div className="gap-compact flex flex-col">
          <Heading level={1}>{t('title')}</Heading>
          <p className={P}>{t('lead')}</p>
        </div>

        <Section title={t('where.title')}>
          <ol className={`${LIST} list-decimal`}>
            <li>{t('where.step1')}</li>
            <li>{t('where.step2')}</li>
            <li>{t('where.step3')}</li>
            <li>{t('where.step4')}</li>
          </ol>
          <p>
            <TextLink tone="link" href={PROFILE_HREF} data-testid="delete-account-help-profile">
              {t('where.link')}
            </TextLink>
          </p>
        </Section>

        <Section title={t('upcoming.title')}>
          <p className={P}>{t('upcoming.body')}</p>
          <ul className={`${LIST} list-disc`}>
            <li>{t('upcoming.cancel')}</li>
            <li>{t('upcoming.leave')}</li>
            <li>{t('upcoming.wait')}</li>
          </ul>
          <p className={P}>{t('upcoming.profile')}</p>
        </Section>

        <Section title={t('deleted.title')}>
          <ul className={`${LIST} list-disc`}>
            <li>{t('deleted.identity')}</li>
            <li>{t('deleted.sports')}</li>
            <li>{t('deleted.notifications')}</li>
            <li>{t('deleted.reviews')}</li>
            <li>{t('deleted.links')}</li>
            <li>{t('deleted.clubs')}</li>
            <li>{t('deleted.devices')}</li>
          </ul>
        </Section>

        <Section title={t('kept.title')}>
          <p className={P}>{t('kept.bookings')}</p>
          <p className={P}>{t('kept.logs')}</p>
          <p className={P} data-testid="delete-account-help-no-shows">
            {t('kept.noShows')}
          </p>
          <p className={P} data-testid="delete-account-help-credit">
            {t('kept.credit')}
          </p>
        </Section>

        <Section title={t('club.title')}>
          <p className={P}>{t('club.body')}</p>
          <p>
            <TextLink
              tone="link"
              href={CONTACT_FORM_HREF}
              data-testid="delete-account-help-contact"
            >
              {t('club.link')}
            </TextLink>
          </p>
        </Section>

        <Section title={t('export.title')}>
          <p className={P}>{t('export.body')}</p>
        </Section>

        <Section title={t('after.title')}>
          <p className={P}>{t('after.body')}</p>
          <p className={P}>{t('after.facebook')}</p>
        </Section>
      </article>
    </>
  );
}
