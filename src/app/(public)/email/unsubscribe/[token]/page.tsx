import { getTranslations } from 'next-intl/server';

import { unsubscribeStanding } from '@/app-layer/usecases/email-unsubscribe';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { InlineNotice } from '@/components/ui/inline-notice';
import { Heading, TextLink } from '@/components/ui/typography';

import { stopEmailsAction } from './actions';

export async function generateMetadata() {
  const t = await getTranslations('emailUnsubscribe');
  // A page per token, about one account's settings: nothing to index.
  return { title: t('metaTitle'), robots: { index: false, follow: false } };
}

/**
 * "Спиране на имейли" (#528): where the link in an email's footer lands.
 *
 * ═══ NO SIGN-IN ═══
 *
 * The link is the authority (src/lib/email/unsubscribe.ts): it names one
 * account and one kind of email, and can only switch that kind off. A person
 * who wants an email to stop should not have to find a password first.
 *
 * ═══ A PAGE WITH A BUTTON, NOT A LINK THAT ACTS ═══
 *
 * Opening the page changes nothing. Mail scanners and link previews open
 * every link in an email; if the GET did it, they would unsubscribe people
 * who never pressed anything. The person presses «Спри тези имейли».
 *
 * (A mail client's own "unsubscribe" button does not come here: it POSTs to
 * `/api/email/unsubscribe/{token}`, which is the one-click of RFC 8058.)
 *
 * ═══ ONE MESSAGE FOR EVERY LINK THAT IS NOT OURS ═══
 *
 * A cut-off link, a made-up one, and one signed with a key since rotated all
 * read the same, and point at the profile, where the same switches are.
 */
export default async function EmailUnsubscribePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const [t, tKinds] = await Promise.all([
    getTranslations('emailUnsubscribe'),
    getTranslations('profile.notifications'),
  ]);
  const standing = await unsubscribeStanding(decodeURIComponent(token));

  const settings = (
    <p className="text-content-muted mt-4 text-sm">
      {t.rich('settings', {
        link: (chunks) => (
          <TextLink tone="link" href="/me/profile">
            {chunks}
          </TextLink>
        ),
      })}
    </p>
  );

  if (!standing) {
    return (
      <div className="bg-bg-page text-content-default safe-area-x flex-1">
        <div className="in-shell:p-0 mx-auto max-w-md px-6 py-16" data-testid="unsubscribe-invalid">
          <EmptyState title={t('invalid.title')} description={t('invalid.description')} />
          {settings}
        </div>
      </div>
    );
  }

  const kind = tKinds(standing.category);

  return (
    <div className="bg-bg-page text-content-default safe-area-x flex-1">
      <div className="in-shell:p-0 mx-auto max-w-md px-6 py-16">
        <Heading level={1}>{t('title')}</Heading>
        {standing.on ? (
          <>
            <p className="text-content-default mt-2" data-testid="unsubscribe-ask">
              {t('ask', { kind })}
            </p>
            <p className="text-content-muted mt-1 text-sm">{t('bell')}</p>
            <form action={stopEmailsAction.bind(null, token)} className="mt-6">
              <Button type="submit" data-testid="unsubscribe-submit">
                {t('submit')}
              </Button>
            </form>
          </>
        ) : (
          <InlineNotice variant="success" className="mt-4" data-testid="unsubscribe-done">
            {t('done', { kind })}
          </InlineNotice>
        )}
        {settings}
      </div>
    </div>
  );
}
