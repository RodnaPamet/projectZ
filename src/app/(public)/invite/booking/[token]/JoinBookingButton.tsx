'use client';

import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { InlineNotice } from '@/components/ui/inline-notice';
import { isApiClientError } from '@/lib/data/errors';
import { V1 } from '@/lib/data/keys';
import { useV1Mutation } from '@/lib/data/use-v1-mutation';

/** Why joining failed, as a key under `bookingInvite.error`. */
export type JoinErrorKey =
  'FULL' | 'NOT_USABLE' | 'PLAYER_ACCOUNT_REQUIRED' | 'RATE_LIMITED' | 'FAILED';

export function joinErrorKey(e: unknown): JoinErrorKey {
  if (!isApiClientError(e)) return 'FAILED';
  if (e.code === 'BOOKING_FULL') return 'FULL';
  if (e.code === 'BOOKING_INVITE_NOT_USABLE') return 'NOT_USABLE';
  if (e.code === 'PLAYER_ACCOUNT_REQUIRED') return 'PLAYER_ACCOUNT_REQUIRED';
  if (e.status === 429) return 'RATE_LIMITED';
  return 'FAILED';
}

/**
 * "Включи се" (#358): joins the caller to the booking behind the link, then
 * opens it, where they now see it as one of their own. Already on it (the
 * booker, or a second tap) opens it too. A refusal says why, in words.
 */
export function JoinBookingButton({ token, full }: { token: string; full: boolean }) {
  const t = useTranslations('bookingInvite');
  const router = useRouter();
  const [error, setError] = useState<JoinErrorKey | null>(full ? 'FULL' : null);

  const accept = useV1Mutation<void, { bookingId: string; joined: boolean }>({
    url: () => V1.acceptBookingInvite(),
    body: () => ({ token }),
  });

  async function join() {
    setError(null);
    try {
      const res = await accept.trigger();
      if (res) router.push(`/me/bookings/${encodeURIComponent(res.bookingId)}`);
    } catch (e) {
      setError(joinErrorKey(e));
    }
  }

  return (
    <div className="gap-tight flex flex-col">
      <Button
        type="button"
        onClick={() => void join()}
        loading={accept.isMutating}
        disabled={full}
        data-testid="booking-invite-join"
      >
        {t('join')}
      </Button>
      {error ? (
        <InlineNotice
          variant={error === 'FULL' ? 'warning' : 'error'}
          data-testid="booking-invite-error"
        >
          {t(`error.${error}`)}
        </InlineNotice>
      ) : null}
    </div>
  );
}
