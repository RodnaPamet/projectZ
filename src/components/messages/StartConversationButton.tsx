'use client';

import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useState } from 'react';

import { Button, type ButtonProps } from '@/components/ui/button';
import { Msgs } from '@/components/ui/icons/nucleo';
import { InlineNotice } from '@/components/ui/inline-notice';
import type { ApiClientError } from '@/lib/data/errors';
import { V1, type InboxSide } from '@/lib/data/keys';
import { useV1Mutation } from '@/lib/data/use-v1-mutation';
import { conversationPath } from '@/lib/messaging/paths';

/**
 * "Пиши" and "Пиши на клуба" (#375): open the conversation with a player or a
 * club — the one there is, or a new one — and go to it.
 *
 * The open is idempotent on the server, so a double tap is one conversation.
 * Nothing is said until the person writes: a conversation nobody has written
 * in shows in no inbox. A refusal names itself: a player who cannot be written
 * to reads the same as one who does not exist (PLAYER_NOT_FOUND).
 */
export function StartConversationButton({
  to,
  side = ME,
  label,
  variant = 'secondary',
  size,
  className,
  testId = 'start-conversation',
}: {
  /** A player by id, a club by its slug, or a player by their place on a booking. */
  to: { playerId: string } | { club: string } | { bookingId: string; participantId: string | null };
  /**
   * Who is writing: the player (default), or a club's staff from its admin —
   * where only `{ playerId }` applies, and only for a player on the club's list.
   */
  side?: InboxSide;
  label?: string;
  variant?: ButtonProps['variant'];
  size?: ButtonProps['size'];
  className?: string;
  testId?: string;
}) {
  const t = useTranslations('messaging.start');
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);

  const open = useV1Mutation<void, { id: string; created: boolean }>({
    url: () => V1.openConversation(side),
    body: () => to,
    revalidate: false,
  });

  return (
    <div className={className}>
      <Button
        type="button"
        variant={variant}
        size={size}
        icon={<Msgs aria-hidden="true" />}
        loading={open.isMutating}
        onClick={() => {
          setError(null);
          open
            .trigger()
            .then((r) => {
              if (r) router.push(conversationPath(side, r.id));
            })
            .catch((err: ApiClientError) => setError(err.code));
        }}
        data-testid={testId}
      >
        {label ?? t('write')}
      </Button>
      {error ? (
        <InlineNotice variant="error" className="mt-2" data-testid={`${testId}-error`}>
          {t(`error.${START_ERRORS.includes(error) ? error : 'UNKNOWN'}`)}
        </InlineNotice>
      ) : null}
    </div>
  );
}

const ME = { kind: 'me' } as const;

const START_ERRORS = [
  'PLAYER_NOT_FOUND',
  'CLUB_NOT_FOUND',
  'PLAYER_ACCOUNT_REQUIRED',
  'RATE_LIMITED',
  'CANNOT_MESSAGE_SELF',
  'NOT_A_CLUB_PLAYER',
];
