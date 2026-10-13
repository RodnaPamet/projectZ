'use client';

import { useTranslations } from 'next-intl';
import { useId, useState, type Dispatch, type SetStateAction } from 'react';

import type { OpenGameDto } from '@/app/api/v1/_lib/open-play-dto';
import { Button } from '@/components/ui/button';
import { InlineNotice } from '@/components/ui/inline-notice';
import { Label } from '@/components/ui/label';
import { Modal } from '@/components/ui/modal';
import { Caption } from '@/components/ui/typography';
import { Textarea } from '@/components/ui/textarea';
import { V1 } from '@/lib/data/keys';
import { useV1Mutation } from '@/lib/data/use-v1-mutation';
import { OPEN_PLAY_NOTE_MAX } from '@/lib/open-play/limits';

import { openPlayErrorKey, type OpenPlayErrorKey } from './game-copy';

/**
 * Asking to join an open game (#376): what the game is, that the booker
 * decides, that payment is at the club, and an optional note to the booker.
 * Every join is a request (owner decision 2026-10-13), so there is no "join"
 * here, only "ask".
 */
export function AskDialog({
  game,
  when,
  open,
  setOpen,
  onAsked,
}: {
  game: OpenGameDto;
  /** «пт, 17 окт., 19:00», in the venue's zone, as the card shows it. */
  when: { date: string; time: string };
  open: boolean;
  setOpen: Dispatch<SetStateAction<boolean>>;
  onAsked: (game: OpenGameDto) => void;
}) {
  const t = useTranslations('games.ask');
  const tGames = useTranslations('games');
  const ids = useId();
  const [note, setNote] = useState('');
  const [error, setError] = useState<OpenPlayErrorKey | null>(null);

  const ask = useV1Mutation<{ note: string }, OpenGameDto>({
    url: () => V1.askToJoinGame(game.id),
    body: ({ note: n }) => (n ? { note: n } : {}),
  });

  async function send() {
    setError(null);
    try {
      const updated = await ask.trigger({ note: note.trim() });
      if (updated) onAsked(updated);
      setNote('');
      setOpen(false);
    } catch (e) {
      setError(openPlayErrorKey(e));
    }
  }

  return (
    <Modal showModal={open} setShowModal={setOpen} size="sm" title={t('title')}>
      <Modal.Header
        title={t('title')}
        description={t('description', {
          venue: game.venue.name,
          date: when.date,
          time: when.time,
        })}
      />
      <Modal.Form
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <Modal.Body className="gap-section grid content-start" data-testid="ask-dialog">
          <div className="gap-tight grid">
            <Label htmlFor={`${ids}-note`}>{t('noteLabel')}</Label>
            <Textarea
              id={`${ids}-note`}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={3}
              maxLength={OPEN_PLAY_NOTE_MAX}
              placeholder={t('notePlaceholder')}
              data-testid="ask-note"
            />
            <Caption>{t('noteHint', { max: OPEN_PLAY_NOTE_MAX })}</Caption>
          </div>
          {error ? (
            <InlineNotice variant="error" data-testid="ask-error">
              {tGames(`error.${error}`)}
            </InlineNotice>
          ) : null}
        </Modal.Body>
        <Modal.Actions>
          <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
            {t('cancel')}
          </Button>
          <Button type="submit" loading={ask.isMutating} data-testid="ask-submit">
            {t('submit')}
          </Button>
        </Modal.Actions>
      </Modal.Form>
    </Modal>
  );
}
