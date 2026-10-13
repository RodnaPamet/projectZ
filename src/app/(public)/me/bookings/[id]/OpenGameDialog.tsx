'use client';

import { useTranslations } from 'next-intl';
import { useId, useState, type Dispatch, type SetStateAction } from 'react';

import type { BookingGameDto } from '@/app/api/v1/_lib/open-play-dto';
import { openPlayErrorKey, type OpenPlayErrorKey } from '@/components/games/game-copy';
import { Button } from '@/components/ui/button';
import { InlineNotice } from '@/components/ui/inline-notice';
import { Label } from '@/components/ui/label';
import { Modal } from '@/components/ui/modal';
import { Textarea } from '@/components/ui/textarea';
import { ToggleGroup } from '@/components/ui/toggle-group';
import { Caption } from '@/components/ui/typography';
import { V1 } from '@/lib/data/keys';
import { useV1Mutation } from '@/lib/data/use-v1-mutation';
import { OPEN_PLAY_NOTE_MAX } from '@/lib/open-play/limits';
import { MAX_SPORT_LEVEL, MIN_SPORT_LEVEL } from '@/lib/profile/limits';

const LEVELS = Array.from(
  { length: MAX_SPORT_LEVEL - MIN_SPORT_LEVEL + 1 },
  (_, i) => MIN_SPORT_LEVEL + i,
);

interface OpenBody {
  spots: number;
  levelMin: number | null;
  levelMax: number | null;
  note: string | null;
}

/**
 * «Търся играчи» (#376): how many more players, the level the booker would
 * like (a wish, never a rule: every asker is answered by the booker), and a
 * note anyone who sees the game reads. Opens, changes or reopens the game.
 */
export function OpenGameDialog({
  bookingId,
  view,
  deadline,
  open,
  setOpen,
  onSaved,
}: {
  bookingId: string;
  view: BookingGameDto;
  /** The club's cutoff, formatted: the game is listed until then. */
  deadline: string;
  open: boolean;
  setOpen: Dispatch<SetStateAction<boolean>>;
  onSaved: (view: BookingGameDto) => void;
}) {
  const t = useTranslations('myBookings.game.dialog');
  const tGame = useTranslations('myBookings.game');
  const ids = useId();
  const g = view.game;
  // The court's free places, and never fewer choices than one.
  const most = Math.max(1, view.maxSpots);
  const [spots, setSpots] = useState(Math.min(Math.max(g?.spotsLeft ?? 1, 1), most));
  const [anyLevel, setAnyLevel] = useState(!g || (g.levelMin === null && g.levelMax === null));
  const [levelMin, setLevelMin] = useState(g?.levelMin ?? 3);
  const [levelMax, setLevelMax] = useState(g?.levelMax ?? 4);
  const [note, setNote] = useState(g?.note ?? '');
  const [error, setError] = useState<OpenPlayErrorKey | null>(null);

  const save = useV1Mutation<OpenBody, BookingGameDto>({
    url: () => V1.bookingGame(bookingId),
    method: 'PUT',
    body: (b) => b,
  });

  async function submit() {
    setError(null);
    try {
      const saved = await save.trigger({
        spots,
        levelMin: anyLevel ? null : Math.min(levelMin, levelMax),
        levelMax: anyLevel ? null : Math.max(levelMin, levelMax),
        note: note.trim() || null,
      });
      if (saved) onSaved(saved);
      setOpen(false);
    } catch (e) {
      setError(openPlayErrorKey(e));
    }
  }

  const levelOptions = LEVELS.map((l) => ({ value: String(l), label: String(l) }));

  return (
    <Modal showModal={open} setShowModal={setOpen} size="sm" title={t('title')}>
      <Modal.Header title={t('title')} description={t('description', { deadline })} />
      <Modal.Form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Modal.Body className="gap-section grid content-start" data-testid="open-game-dialog">
          <div className="gap-tight grid">
            <span id={`${ids}-spots`} className="text-content-default text-sm">
              {t('spots')}
            </span>
            <ToggleGroup
              ariaLabel={t('spots')}
              options={Array.from({ length: most }, (_, i) => ({
                value: String(i + 1),
                label: String(i + 1),
              }))}
              selected={String(spots)}
              selectAction={(v) => setSpots(Number(v))}
              className="justify-self-start"
              optionClassName="min-h-11 min-w-11"
            />
          </div>

          <div className="gap-tight grid">
            <span className="text-content-default text-sm">{t('level')}</span>
            <ToggleGroup
              ariaLabel={t('level')}
              options={[
                { value: 'any', label: t('anyLevel') },
                { value: 'range', label: t('pickLevel') },
              ]}
              selected={anyLevel ? 'any' : 'range'}
              selectAction={(v) => setAnyLevel(v === 'any')}
              className="justify-self-start"
              optionClassName="min-h-11 whitespace-nowrap"
            />
            {anyLevel ? null : (
              <div className="gap-tight grid" data-testid="open-game-levels">
                <Caption>{t('levelFrom')}</Caption>
                <ToggleGroup
                  size="sm"
                  ariaLabel={t('levelFrom')}
                  options={levelOptions}
                  selected={String(levelMin)}
                  selectAction={(v) => setLevelMin(Number(v))}
                  className="justify-self-start"
                  optionClassName="min-h-11 min-w-10"
                />
                <Caption>{t('levelTo')}</Caption>
                <ToggleGroup
                  size="sm"
                  ariaLabel={t('levelTo')}
                  options={levelOptions}
                  selected={String(levelMax)}
                  selectAction={(v) => setLevelMax(Number(v))}
                  className="justify-self-start"
                  optionClassName="min-h-11 min-w-10"
                />
                <Caption>{t('levelHint')}</Caption>
              </div>
            )}
          </div>

          <div className="gap-tight grid">
            <Label htmlFor={`${ids}-note`}>{t('note')}</Label>
            <Textarea
              id={`${ids}-note`}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={3}
              maxLength={OPEN_PLAY_NOTE_MAX}
              placeholder={t('notePlaceholder')}
              data-testid="open-game-note"
            />
          </div>

          {error ? (
            <InlineNotice variant="error" data-testid="open-game-error">
              {tGame(`error.${error}`)}
            </InlineNotice>
          ) : null}
        </Modal.Body>
        <Modal.Actions>
          <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
            {t('cancel')}
          </Button>
          <Button type="submit" loading={save.isMutating} data-testid="open-game-submit">
            {g && !g.closedAt ? t('save') : t('submit')}
          </Button>
        </Modal.Actions>
      </Modal.Form>
    </Modal>
  );
}
