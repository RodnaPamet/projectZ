'use client';

import { useActionState, useId, useState, type Dispatch, type SetStateAction } from 'react';
import { useFormatter, useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { FormField } from '@/components/ui/form-field';
import { InlineNotice } from '@/components/ui/inline-notice';
import { Input } from '@/components/ui/input';
import { Sheet } from '@/components/ui/sheet';
import { ToggleGroup } from '@/components/ui/toggle-group';
import { Heading } from '@/components/ui/typography';

import { adjustCreditAction, clearNoShowBlockAction } from './actions';
import type { PlayerRow } from './PlayersBoard';

/**
 * One player's standing at the club: tags, and (for OWNER and MANAGER) credit.
 *
 * Opened from a row of the players table, or a card on a phone. The sheet is
 * the bottom drawer below md and a side panel above it, so the list stays in
 * view on a desktop while a tag is edited.
 */
export default function PlayerSheet({
  slug,
  player,
  canAdjustCredit,
  canLiftNoShowBlock,
  noShowWindowDays,
  open,
  setOpen,
  onSaveTags,
}: {
  slug: string;
  player: PlayerRow;
  canAdjustCredit: boolean;
  canLiftNoShowBlock: boolean;
  noShowWindowDays: number;
  open: boolean;
  setOpen: Dispatch<SetStateAction<boolean>>;
  /** The board's optimistic save: it closes this sheet and updates the row. */
  onSaveTags: (form: FormData) => void;
}) {
  const t = useTranslations('admin.players');
  const format = useFormatter();
  const ids = useId();
  const title = player.name ?? player.email;

  return (
    <Sheet open={open} onOpenChange={setOpen} title={title} size="sm">
      <Sheet.Header title={title} description={player.name ? player.email : undefined} />
      <Sheet.Body className="gap-section grid content-start">
        <p className="text-content-muted">
          {t('field.credit')}:{' '}
          <span className="text-content-emphasis tabular-nums">
            {format.number(player.creditCents / 100, { style: 'currency', currency: 'EUR' })}
          </span>
        </p>

        {(player.noShowBlock.blocked || player.noShowBlock.lastLiftedAt) && (
          <NoShowBlock
            key={player.playerUserId}
            slug={slug}
            player={player}
            canLift={canLiftNoShowBlock}
            windowDays={noShowWindowDays}
          />
        )}

        <form
          className="gap-compact grid"
          onSubmit={(e) => {
            e.preventDefault();
            onSaveTags(new FormData(e.currentTarget));
          }}
        >
          <FormField
            label={t('field.tags')}
            // Tags are matched by PricingConditions.playerTags, so a club can
            // price by them — worth saying, or "vip" looks decorative.
            description={t('field.tagsHint')}
          >
            <Input
              id={`${ids}-tags`}
              name="tags"
              defaultValue={player.tags.join(', ')}
              placeholder={t('field.tagsPlaceholder')}
              autoComplete="off"
            />
          </FormField>
          <div>
            <Button type="submit">{t('action.saveTags')}</Button>
          </div>
        </form>

        {canAdjustCredit && <CreditForm key={player.playerUserId} slug={slug} player={player} />}
      </Sheet.Body>
    </Sheet>
  );
}

/**
 * Credit, through the ledger. NOT optimistic: the balance above moves when the
 * revalidated row arrives, i.e. after SERIALIZABLE has agreed to it.
 */
function CreditForm({ slug, player }: { slug: string; player: PlayerRow }) {
  const t = useTranslations('admin.players');
  const format = useFormatter();
  const ids = useId();
  const [state, formAction, pending] = useActionState(
    adjustCreditAction.bind(null, slug, player.playerUserId),
    null,
  );
  const [chosen, setChosen] = useState<'credit' | 'debit'>('credit');

  // The ledger refuses to go below zero, so a debit is capped at what is
  // there. Offering more would be a form that throws on submit — and a balance
  // that reached zero while "debit" was chosen falls back to "credit".
  const canDebit = player.creditCents > 0;
  const direction = chosen === 'debit' && canDebit ? 'debit' : 'credit';
  const maxDebit = player.creditCents / 100;

  return (
    <form action={formAction} className="gap-compact border-border-subtle pt-default grid border-t">
      <Heading level={3}>{t('field.adjust')}</Heading>

      {/* The ToggleGroup is a radiogroup of buttons, not form controls: the
          choice posts through this input, under the name the action reads. */}
      <input type="hidden" name="direction" value={direction} />
      <ToggleGroup
        ariaLabel={t('field.direction')}
        className="w-fit"
        options={[
          { value: 'credit', label: t('direction.credit') },
          { value: 'debit', label: t('direction.debit'), disabled: !canDebit },
        ]}
        selected={direction}
        selectAction={(v) => setChosen(v === 'debit' ? 'debit' : 'credit')}
      />

      <FormField
        label={t('field.amount')}
        description={
          direction === 'debit'
            ? t('field.maxDebit', {
                amount: format.number(maxDebit, { style: 'currency', currency: 'EUR' }),
              })
            : undefined
        }
      >
        <Input
          id={`${ids}-amount`}
          name="amount"
          type="number"
          inputMode="decimal"
          step="0.01"
          min="0.01"
          max={direction === 'debit' ? maxDebit : undefined}
          required
        />
      </FormField>

      <FormField label={t('field.note')}>
        <Input
          id={`${ids}-note`}
          name="note"
          required
          minLength={8}
          placeholder={t('field.notePlaceholder')}
          autoComplete="off"
        />
      </FormField>

      <div>
        <Button type="submit" disabled={pending}>
          {t('action.adjust')}
        </Button>
      </div>

      {state && !pending && !state.ok && (
        <InlineNotice variant="error">{t(`error.${state.error}` as never)}</InlineNotice>
      )}
      {state?.ok && !pending && <InlineNotice variant="success">{t('creditSaved')}</InlineNotice>}
    </form>
  );
}

/**
 * The no-show block on online booking (#354): why it is in force, and — for the
 * desk — the button that lifts it. Not optimistic: the badge on the row goes
 * when the revalidated page says the block is gone.
 */
function NoShowBlock({
  slug,
  player,
  canLift,
  windowDays,
}: {
  slug: string;
  player: PlayerRow;
  canLift: boolean;
  windowDays: number;
}) {
  const t = useTranslations('admin.players');
  const format = useFormatter();
  const [state, lift, pending] = useActionState(
    async () => clearNoShowBlockAction(slug, player.playerUserId),
    null,
  );
  const { blocked, recentNoShows, lastLiftedAt } = player.noShowBlock;

  return (
    <div className="gap-compact grid">
      {blocked && (
        <InlineNotice variant="warning">
          {t('noShowBlock.summary', { count: recentNoShows, days: windowDays })}
        </InlineNotice>
      )}
      {lastLiftedAt && (
        <p className="text-content-muted text-sm">
          {t('noShowBlock.lastLifted', {
            date: format.dateTime(new Date(lastLiftedAt), { dateStyle: 'medium' }),
          })}
        </p>
      )}
      {blocked && canLift && (
        <form action={lift}>
          <Button type="submit" variant="secondary" disabled={pending}>
            {t('noShowBlock.lift')}
          </Button>
        </form>
      )}
      {state && !pending && !state.ok && (
        <InlineNotice variant="error">{t('noShowBlock.notBlocked')}</InlineNotice>
      )}
      {state?.ok && !pending && (
        <InlineNotice variant="success">{t('noShowBlock.lifted')}</InlineNotice>
      )}
    </div>
  );
}
