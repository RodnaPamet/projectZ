'use client';

import { useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';

import { MonthPicker } from '@/components/billing/MonthPicker';

/**
 * The reports page's month: choosing one navigates to `?month=YYYY-MM`, and the
 * server renders that month's statement. The month lives in the URL so a
 * statement is a link, and Back returns to the month before.
 */
export function ReportsMonthNav({
  slug,
  months,
  month,
}: {
  slug: string;
  months: readonly string[];
  month: string;
}) {
  const t = useTranslations('admin.reports');
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  return (
    <div aria-busy={pending || undefined}>
      <MonthPicker
        label={t('month')}
        months={months}
        value={month}
        onSelect={(m) =>
          startTransition(() =>
            router.push(`/t/${encodeURIComponent(slug)}/admin/reports?month=${m}`),
          )
        }
      />
    </div>
  );
}
