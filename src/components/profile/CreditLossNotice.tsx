'use client';

import { useFormatter, useTranslations } from 'next-intl';

import { InlineNotice } from '@/components/ui/inline-notice';

/** Unused credit at one club, which goes with the account. */
export interface ClubCreditView {
  club: string;
  balanceCents: number;
}

/**
 * "Ще загубите кредита си" (#370 review): each club's unused credit, which is
 * not returned once the account is deleted. The owner's decision is warn, then
 * allow, so this says it in the section and again in the dialog, and never
 * holds the button back. Nothing when there is none.
 *
 * Euro, as the club's players list shows the same balance.
 */
export function CreditLossNotice({ credit }: { credit: ClubCreditView[] }) {
  const t = useTranslations('profile.delete.credit');
  const format = useFormatter();
  if (credit.length === 0) return null;
  return (
    <InlineNotice variant="warning" title={t('title')} data-testid="profile-delete-credit">
      <p>{t('body')}</p>
      <ul className="my-1 list-disc pl-5">
        {credit.map((c, i) => (
          <li key={`${i}-${c.club}`} data-testid="profile-delete-credit-club">
            {t('line', {
              club: c.club,
              amount: format.number(c.balanceCents / 100, { style: 'currency', currency: 'EUR' }),
            })}
          </li>
        ))}
      </ul>
      <p>{t('hint')}</p>
    </InlineNotice>
  );
}
