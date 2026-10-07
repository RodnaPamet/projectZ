'use client';

import Link from 'next/link';
import { useId, useState } from 'react';
import { useFormatter, useTranslations } from 'next-intl';

import { StatementView } from '@/components/billing/StatementView';
import { Button } from '@/components/ui/button';
import { FormField } from '@/components/ui/form-field';
import { InlineNotice } from '@/components/ui/inline-notice';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Heading } from '@/components/ui/typography';
import type { ClubStatementDto } from '@/lib/billing/statement-dto';
import { isApiClientError } from '@/lib/data/errors';
import { KEYS, V1 } from '@/lib/data/keys';
import { needsSkeleton, useV1SWR } from '@/lib/data/use-v1-swr';

/**
 * A club's statement read from the platform (#372). An audited read, so it
 * happens once, with the reason the owner stated (carried from the overview,
 * or typed here), and never again on focus or reconnect.
 */
const MIN_REASON = 12;

const KNOWN_ERRORS = new Set([
  'PLATFORM_AUTHORITY_REQUIRED',
  'PLATFORM_CAPABILITY_REQUIRED',
  'REASON_REQUIRED',
  'REASON_TOO_LONG',
  'BAD_REQUEST',
  'NOT_FOUND',
  'UNAUTHORIZED',
  'NETWORK',
  'VIEWER_CHANGED',
]);

export function ClubStatementPanel({
  clubId,
  month,
  initialReason,
}: {
  clubId: string;
  month: string;
  initialReason: string;
}) {
  const t = useTranslations('platform.fees');
  const format = useFormatter();
  const ids = useId();
  const ready = (r: string) => r.trim().length >= MIN_REASON;
  const [reason, setReason] = useState(initialReason);
  const [submitted, setSubmitted] = useState<string | null>(
    ready(initialReason) ? initialReason.trim() : null,
  );

  const params = submitted ? { month, reason: submitted } : null;
  const statement = useV1SWR<ClubStatementDto>(
    params ? KEYS.platformClubStatement(clubId, params) : null,
    { audited: true },
  );
  const error = statement.error;
  const code = isApiClientError(error) && KNOWN_ERRORS.has(error.code) ? error.code : 'UNKNOWN';

  const [y, m] = month.split('-').map(Number) as [number, number];
  const monthLabel = format.dateTime(new Date(Date.UTC(y, m - 1, 15, 12)), {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });

  return (
    <div className="gap-section grid">
      <Link
        href="/platform/fees"
        className="text-content-muted text-sm underline-offset-2 hover:underline"
      >
        {t('back')}
      </Link>

      {submitted === null && (
        <form
          className="border-border-subtle bg-bg-default grid gap-3 rounded-lg border p-4 sm:max-w-xl"
          onSubmit={(e) => {
            e.preventDefault();
            if (ready(reason)) setSubmitted(reason.trim());
          }}
        >
          <FormField label={t('reasonLabel')} description={t('reasonHint')}>
            <Input
              id={`${ids}-reason`}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              maxLength={500}
              autoComplete="off"
            />
          </FormField>
          <div>
            <Button type="submit" disabled={!ready(reason)}>
              {t('open')}
            </Button>
          </div>
        </form>
      )}

      {error && <InlineNotice variant="error">{t(`error.${code}` as never)}</InlineNotice>}

      {params && needsSkeleton(statement) && (
        <div className="gap-compact grid" aria-busy>
          <Skeleton className="h-8 w-64" />
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-10 w-full" />
          ))}
        </div>
      )}

      {params && statement.data && (
        <>
          <Heading level={2}>
            {t('statementHeading', { club: statement.data.club.name, month: monthLabel })}
          </Heading>
          <StatementView
            statement={statement.data}
            csvHref={V1.platformClubStatementCsv(clubId, params)}
          />
        </>
      )}
    </div>
  );
}
