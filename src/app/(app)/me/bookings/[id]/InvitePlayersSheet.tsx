'use client';

import { useTranslations } from 'next-intl';
import { useState } from 'react';

import type {
  BookingInviteLinkDto,
  BookingParticipantsDto,
  CoPlayerDto,
  MyBookingDetailDto,
} from '@/app/api/v1/_lib/dto';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { InitialsAvatar } from '@/components/ui/initials-avatar';
import { InlineNotice } from '@/components/ui/inline-notice';
import { Sheet } from '@/components/ui/sheet';
import { Caption, Heading } from '@/components/ui/typography';
import { KEYS, V1 } from '@/lib/data/keys';
import { useV1Mutation } from '@/lib/data/use-v1-mutation';
import { useV1SWR } from '@/lib/data/use-v1-swr';
import { resourceNoun } from '@/lib/sports/resource-kinds';

import { bookingPlayerReads, playersErrorKey, type PlayersErrorKey } from './BookingPlayers';

/** What happened to the link the last time the booker pressed Share. */
export type ShareOutcome = 'shared' | 'copied' | 'manual';

/**
 * Hand the link to the phone's own share sheet where there is one, and copy it
 * where there is not. `manual` when neither worked (no clipboard permission,
 * or the share sheet refused because the tap's activation was spent on the
 * request that made the link): the link is then on screen with its own Share
 * and Copy buttons, each a fresh tap.
 *
 * A dismissed share sheet (AbortError) is the person changing their mind, and
 * counts as shared: nothing to explain. Pure over `nav`, so it is tested
 * without a browser.
 */
export async function shareInviteLink(
  nav: Pick<Navigator, 'share' | 'clipboard'> | undefined,
  data: { title: string; text: string; url: string },
): Promise<ShareOutcome> {
  if (nav && typeof nav.share === 'function') {
    try {
      await nav.share(data);
      return 'shared';
    } catch (e) {
      if (e instanceof Error && e.name === 'AbortError') return 'shared';
    }
  }
  return copyInviteLink(nav, data.url);
}

/** The clipboard alone: the Copy button, and Share's fallback. */
export async function copyInviteLink(
  nav: Pick<Navigator, 'clipboard'> | undefined,
  url: string,
): Promise<ShareOutcome> {
  if (nav?.clipboard && typeof nav.clipboard.writeText === 'function') {
    try {
      await nav.clipboard.writeText(url);
      return 'copied';
    } catch {
      return 'manual';
    }
  }
  return 'manual';
}

function currentNavigator(): Navigator | undefined {
  return typeof navigator === 'undefined' ? undefined : navigator;
}

/**
 * "Покани играчи" (#358, Q29): the sheet behind the booking detail's button.
 *
 *   1. Share a link. Made on the first press (`POST …/invite-links`), then
 *      handed to the native share sheet, or copied where there is none. The
 *      link adds whoever opens it and signs in, while there is room, until the
 *      game starts. Made once per visit: pressing again shares the same link.
 *   2. Stop the links: every live one, when there are any. Players already
 *      added stay.
 *   3. Add somebody the booker has played with, from `GET …/co-players`.
 *
 * A full court says so and offers no add; the link still works for when
 * somebody leaves. Everything here is read only while the sheet is open.
 */
export function InvitePlayersSheet({
  booking: b,
  date,
  time,
  open,
  onOpenChange,
}: {
  booking: MyBookingDetailDto;
  date: string;
  time: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations('myBookings.players');
  const td = useTranslations('myBookings.detail');
  const [link, setLink] = useState<BookingInviteLinkDto | null>(null);
  const [outcome, setOutcome] = useState<ShareOutcome | 'stopped' | null>(null);
  const [error, setError] = useState<PlayersErrorKey | null>(null);
  const related = bookingPlayerReads(b.id);

  const participants = useV1SWR<BookingParticipantsDto>(
    open ? KEYS.meBookingParticipants(b.id) : null,
  );
  const coPlayers = useV1SWR<CoPlayerDto[]>(open ? KEYS.meBookingCoPlayers(b.id) : null);

  const createLink = useV1Mutation<void, BookingInviteLinkDto>({
    url: () => V1.bookingInviteLinks(b.id),
    related: { keys: related.keys },
  });
  const stopLinks = useV1Mutation<void>({
    url: () => V1.bookingInviteLinks(b.id),
    method: 'DELETE',
    related: { keys: related.keys },
  });
  const add = useV1Mutation<{ userId: string }>({
    url: () => V1.addBookingPlayer(b.id),
    body: ({ userId }) => ({ userId }),
    related,
  });

  const spotsLeft = participants.data?.spotsLeft ?? b.spotsLeft;
  const liveLinks = participants.data?.liveInviteLinks ?? 0;
  const full = spotsLeft <= 0;
  const shareData = (url: string) => ({
    title: t('shareTitle'),
    text: t('shareText', { venue: b.venue.name, date, time }),
    url,
  });

  async function share() {
    setError(null);
    setOutcome(null);
    let current = link;
    if (!current) {
      try {
        current = (await createLink.trigger()) ?? null;
      } catch (e) {
        setError(playersErrorKey(e));
        return;
      }
      if (!current) return;
      setLink(current);
    }
    setOutcome(await shareInviteLink(currentNavigator(), shareData(current.url)));
  }

  async function copy() {
    if (!link) return;
    setOutcome(await copyInviteLink(currentNavigator(), link.url));
  }

  async function stop() {
    setError(null);
    try {
      await stopLinks.trigger();
      setLink(null);
      setOutcome('stopped');
    } catch (e) {
      setError(playersErrorKey(e));
    }
  }

  async function addPlayer(userId: string) {
    setError(null);
    try {
      await add.trigger({ userId });
    } catch (e) {
      setError(playersErrorKey(e));
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange} title={t('sheetTitle')} size="sm">
      <Sheet.Header
        title={t('sheetTitle')}
        description={t('sheetDescription', { count: Math.max(0, b.capacity - 1) })}
      />
      <Sheet.Body className="gap-section flex flex-col" data-testid="invite-sheet">
        <section className="gap-tight flex flex-col">
          <Caption data-testid="invite-spots-left">{t('spotsLeft', { count: spotsLeft })}</Caption>
          {full ? (
            <InlineNotice variant="info" data-testid="invite-full">
              {t(resourceNoun(b.resource.resourceType) === 'track' ? 'track.full' : 'full')}
            </InlineNotice>
          ) : null}
          <Button
            type="button"
            onClick={() => void share()}
            loading={createLink.isMutating}
            data-testid="invite-share"
          >
            {t('share')}
          </Button>

          {link ? (
            <div className="gap-tight flex flex-col" data-testid="invite-link">
              <Caption>{t('linkReady')}</Caption>
              <Card elevation="flat" density="compact" className="break-all">
                <span className="text-content-default text-sm select-all" data-testid="invite-url">
                  {link.url}
                </span>
              </Card>
              <Button
                type="button"
                variant="secondary"
                className="self-start"
                onClick={() => void copy()}
                data-testid="invite-copy"
              >
                {t('copy')}
              </Button>
            </div>
          ) : null}

          {outcome === 'copied' ? (
            <InlineNotice variant="success" data-testid="invite-copied">
              {t('copied')}
            </InlineNotice>
          ) : null}
          {outcome === 'stopped' ? (
            <InlineNotice variant="success" data-testid="invite-stopped">
              {t('linksStopped')}
            </InlineNotice>
          ) : null}
          {error ? (
            <InlineNotice variant="error" data-testid="invite-error">
              {t(`error.${error}`)}
            </InlineNotice>
          ) : null}

          {liveLinks > 0 ? (
            <div className="flex items-center justify-between gap-3">
              <Caption data-testid="invite-live-links">
                {t('liveLinks', { count: liveLinks })}
              </Caption>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                loading={stopLinks.isMutating}
                onClick={() => void stop()}
                data-testid="invite-stop"
              >
                {t('stopLinks')}
              </Button>
            </div>
          ) : null}
        </section>

        <section className="gap-tight flex flex-col" aria-labelledby="invite-recent">
          <Heading level={3} tone="muted" className="text-sm" id="invite-recent">
            {t('recent')}
          </Heading>
          {coPlayers.data && coPlayers.data.length === 0 ? (
            <EmptyState size="sm" title={t('recentEmpty')} />
          ) : (
            <Card elevation="flat" density="none">
              <ul className="divide-border-subtle divide-y" data-testid="invite-co-players">
                {(coPlayers.data ?? []).map((p) => (
                  <li key={p.userId} className="flex min-h-14 items-center gap-3 px-4 py-2">
                    <InitialsAvatar value={p.name ?? td('unnamed')} imageUrl={p.avatarUrl} />
                    <span className="text-content-default min-w-0 flex-1 truncate text-sm">
                      {p.name ?? td('unnamed')}
                    </span>
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      className="shrink-0"
                      disabled={full || add.isMutating}
                      onClick={() => void addPlayer(p.userId)}
                      data-testid="invite-add"
                    >
                      {t('add')}
                    </Button>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </section>
      </Sheet.Body>
    </Sheet>
  );
}
