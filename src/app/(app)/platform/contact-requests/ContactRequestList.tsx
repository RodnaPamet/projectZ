'use client';

import { useMemo, useState } from 'react';
import { useFormatter, useTranslations } from 'next-intl';

import { CardListSkeleton } from '@/components/loading/shapes';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { InlineNotice } from '@/components/ui/inline-notice';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Caption, Heading, TextLink } from '@/components/ui/typography';
import { isApiClientError } from '@/lib/data/errors';
import { KEYS } from '@/lib/data/keys';
import { needsSkeleton, useV1SWRInfinite } from '@/lib/data/use-v1-swr';
import { LOCALE_LABELS, resolveLocale } from '@/lib/i18n/locales';

/**
 * The club enquiries (#369): a reason, then the list, read from the platform
 * API and nowhere else.
 *
 * The same discipline as the moderation queue: every page read is an audit row
 * with the reason the reader gave, so nothing reads on its own. The key stays
 * null until a reason is submitted, and focus, reconnect and stale-remount
 * revalidation are off (`audited`). Reads happen on "Show", "Load more" and
 * "Reload". CONTACT_READ is a read capability, so there is no step-up.
 */

const MIN_REASON = 12;
const TIME_ZONE = 'Europe/Sofia';

interface ContactRequestItem {
  id: string;
  name: string;
  clubName: string;
  phone: string | null;
  email: string | null;
  message: string;
  locale: string;
  createdAt: string;
}

const KNOWN_ERRORS = new Set([
  'PLATFORM_AUTHORITY_REQUIRED',
  'PLATFORM_CAPABILITY_REQUIRED',
  'REASON_REQUIRED',
  'REASON_TOO_LONG',
  'INVALID_CURSOR',
  'UNAUTHORIZED',
  'RATE_LIMITED',
  'NETWORK',
  'VIEWER_CHANGED',
]);

const knownCode = (e: unknown) =>
  isApiClientError(e) && KNOWN_ERRORS.has(e.code) ? e.code : 'UNKNOWN';

export function ContactRequestList() {
  const t = useTranslations('platform.contactRequests');
  const format = useFormatter();
  const [reason, setReason] = useState('');
  const [submitted, setSubmitted] = useState<string | null>(null);

  const getKey = useMemo(
    () => (submitted ? KEYS.contactRequests({ reason: submitted }) : null),
    [submitted],
  );
  const list = useV1SWRInfinite<ContactRequestItem>(getKey, { audited: true });
  const { data, error, isValidating, setSize, mutate } = list;

  const items = data ? data.flatMap((p) => p.items) : null;
  const nextCursor = data && data.length > 0 ? data[data.length - 1]!.nextCursor : null;
  const reasonReady = reason.trim().length >= MIN_REASON;

  async function open() {
    const r = reason.trim();
    if (r !== submitted) {
      setSubmitted(r);
      return;
    }
    // The same reason again is "Reload": back to page one, read once.
    await setSize(1);
    await mutate();
  }

  return (
    <div className="grid gap-6">
      <form
        className="grid gap-1.5 sm:max-w-xl"
        onSubmit={(e) => {
          e.preventDefault();
          if (reasonReady) void open();
        }}
      >
        <Label htmlFor="contact-reason">{t('reason.label')}</Label>
        <Input
          id="contact-reason"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          minLength={MIN_REASON}
          maxLength={500}
          autoComplete="off"
        />
        <p className="text-content-muted text-sm">{t('reason.hint', { min: MIN_REASON })}</p>
        <div>
          <Button type="submit" disabled={!reasonReady || isValidating}>
            {items === null ? t('open') : t('refresh')}
          </Button>
        </div>
      </form>

      {error && (
        <InlineNotice variant="error">{t(`error.${knownCode(error)}` as never)}</InlineNotice>
      )}

      {submitted && needsSkeleton(list) && (
        <CardListSkeleton rows={3} lines={3} className="gap-4" />
      )}

      {items !== null &&
        (items.length === 0 ? (
          <EmptyState title={t('empty.title')} description={t('empty.description')} />
        ) : (
          <ul className="grid gap-4" data-testid="contact-requests">
            {items.map((item) => (
              <Card
                key={item.id}
                as="li"
                elevation="flat"
                density="compact"
                className="bg-bg-default flex flex-col gap-2"
              >
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <Heading level={2} className="text-base">
                    {item.clubName}
                  </Heading>
                  <Caption>
                    {t('received', {
                      when: format.dateTime(new Date(item.createdAt), {
                        dateStyle: 'medium',
                        timeStyle: 'short',
                        timeZone: TIME_ZONE,
                      }),
                    })}
                  </Caption>
                </div>
                <p className="text-content-default text-sm font-medium">{item.name}</p>
                <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
                  {item.phone && (
                    <>
                      <dt className="text-content-muted">{t('phone')}</dt>
                      <dd>
                        <TextLink tone="link" href={`tel:${item.phone.replace(/[^\d+]/g, '')}`}>
                          {item.phone}
                        </TextLink>
                      </dd>
                    </>
                  )}
                  {item.email && (
                    <>
                      <dt className="text-content-muted">{t('email')}</dt>
                      <dd className="break-all">
                        <TextLink tone="link" href={`mailto:${item.email}`}>
                          {item.email}
                        </TextLink>
                      </dd>
                    </>
                  )}
                </dl>
                <p className="text-content-default text-sm whitespace-pre-wrap">{item.message}</p>
                <Caption className="text-xs">
                  {t('language', { language: LOCALE_LABELS[resolveLocale(item.locale)] })}
                </Caption>
              </Card>
            ))}
          </ul>
        ))}

      {nextCursor && (
        <div>
          <Button
            type="button"
            variant="secondary"
            disabled={isValidating}
            onClick={() => void setSize((n) => n + 1)}
          >
            {t('more')}
          </Button>
        </div>
      )}
    </div>
  );
}
