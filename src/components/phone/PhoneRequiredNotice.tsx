'use client';

import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';

import { buttonVariants } from '@/components/ui/button-variants';
import { InlineNotice } from '@/components/ui/inline-notice';
import { phoneStepHref } from '@/lib/auth/landing';
import { cn } from '@/lib/cn';

/**
 * "Confirm a phone number first" (#500): what a screen shows when the API
 * answered 403 PHONE_REQUIRED to a booking, a join request or a message.
 *
 * It says why in one line and offers the phone step, with the way back to
 * where the person was: `next`, or the page they are on. Nothing was lost:
 * the booking, the request or the message was not made, and the same tap
 * works once the number is confirmed.
 */
export function PhoneRequiredNotice({
  next,
  className,
}: {
  /** Where to come back to; the current page when omitted. */
  next?: string;
  className?: string;
}) {
  const t = useTranslations('phone.required');
  const pathname = usePathname();
  const search = useSearchParams();
  const here = `${pathname ?? '/'}${search && search.size > 0 ? `?${search}` : ''}`;

  return (
    <InlineNotice
      variant="warning"
      title={t('title')}
      className={className}
      data-testid="phone-required"
    >
      <p>{t('body')}</p>
      <Link
        href={phoneStepHref(next ?? here)}
        className={cn(buttonVariants({ variant: 'secondary' }), 'mt-2')}
        data-testid="phone-required-action"
      >
        {t('action')}
      </Link>
    </InlineNotice>
  );
}
