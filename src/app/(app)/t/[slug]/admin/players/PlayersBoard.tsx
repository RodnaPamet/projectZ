'use client';

import { useActionState, useState } from 'react';
import { useFormatter, useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { StatusBadge } from '@/components/ui/status-badge';

import { adjustCreditAction, setPlayerTagsAction } from './actions';

/**
 * The club's players.
 *
 * ═══ WHAT A CLUB MAY CHANGE, AND WHAT IT MAY NOT ═══
 *
 * Name and email are not editable here, and there is no control for them. A
 * `User` is global — one person across every club they play at, with no
 * tenantId and no row security — so a club editing a name would be editing it
 * everywhere, including at clubs that person has never visited.
 *
 * What belongs to the club is the STANDING: tags, and credit.
 */

export interface PlayerRow {
  playerUserId: string;
  name: string | null;
  email: string;
  tags: string[];
  noShowCount: number;
  lastPlayedAt: string | null;
  membershipLevel: string | null;
  creditCents: number;
}

export function PlayersBoard({
  slug,
  players,
  canAdjustCredit,
}: {
  slug: string;
  players: readonly PlayerRow[];
  /** `players.credit_adjust` — OWNER and MANAGER only. A COACH sees no form. */
  canAdjustCredit: boolean;
}) {
  const t = useTranslations('admin.players');
  const format = useFormatter();
  const [search, setSearch] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);

  const money = (cents: number) =>
    format.number(cents / 100, { style: 'currency', currency: 'EUR' });

  const q = search.trim().toLowerCase();
  const visible = q
    ? players.filter(
        (p) => p.email.toLowerCase().includes(q) || (p.name ?? '').toLowerCase().includes(q),
      )
    : players;

  if (players.length === 0) {
    return <EmptyState title={t('empty.title')} description={t('empty.description')} />;
  }

  return (
    <>
      <div className="mb-4 grid gap-1.5 sm:max-w-xs">
        <Label htmlFor="player-search">{t('search')}</Label>
        <Input
          id="player-search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          autoComplete="off"
        />
      </div>

      {visible.length === 0 ? (
        <EmptyState title={t('noMatch.title')} description={t('noMatch.description')} />
      ) : (
        <ul className="grid gap-2">
          {visible.map((p) => (
            <li key={p.playerUserId} className="border-border-subtle rounded-lg border p-3">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <span className="font-medium">{p.name ?? p.email}</span>
                  {p.name && <p className="text-content-muted text-sm">{p.email}</p>}
                  <div className="mt-1 flex flex-wrap gap-1.5">
                    {p.membershipLevel && (
                      <StatusBadge variant="info">{p.membershipLevel}</StatusBadge>
                    )}
                    {p.tags.map((tag) => (
                      <StatusBadge key={tag} variant="neutral">
                        {tag}
                      </StatusBadge>
                    ))}
                    {p.noShowCount > 0 && (
                      <StatusBadge variant="warning">
                        {t('noShows', { count: p.noShowCount })}
                      </StatusBadge>
                    )}
                  </div>
                </div>

                <div className="text-right">
                  <p className="tabular-nums">{money(p.creditCents)}</p>
                  <p className="text-content-muted text-sm">{t('credit')}</p>
                </div>
              </div>

              <div className="mt-2">
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => setOpenId(openId === p.playerUserId ? null : p.playerUserId)}
                >
                  {openId === p.playerUserId ? t('action.close') : t('action.manage')}
                </Button>
              </div>

              {openId === p.playerUserId && (
                <div className="border-border-subtle mt-3 grid gap-4 border-t pt-3 sm:grid-cols-2">
                  <TagsForm slug={slug} player={p} />
                  {canAdjustCredit && <CreditForm slug={slug} player={p} />}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function TagsForm({ slug, player }: { slug: string; player: PlayerRow }) {
  const t = useTranslations('admin.players');
  const [state, formAction, pending] = useActionState(
    setPlayerTagsAction.bind(null, slug, player.playerUserId),
    null,
  );

  return (
    <form action={formAction} className="grid gap-1.5">
      <Label htmlFor={`tags-${player.playerUserId}`}>{t('field.tags')}</Label>
      <Input
        id={`tags-${player.playerUserId}`}
        name="tags"
        defaultValue={player.tags.join(', ')}
        placeholder={t('field.tagsPlaceholder')}
      />
      {/* Tags are matched by PricingConditions.playerTags, so a club can price
          by them — worth saying, or "vip" looks decorative. */}
      <p className="text-content-muted text-sm">{t('field.tagsHint')}</p>
      <div>
        <Button type="submit" disabled={pending}>
          {t('action.saveTags')}
        </Button>
      </div>
      {state && !state.ok && (
        <p role="alert" className="text-content-error text-sm">
          {t(`error.${state.error}`)}
        </p>
      )}
    </form>
  );
}

function CreditForm({ slug, player }: { slug: string; player: PlayerRow }) {
  const t = useTranslations('admin.players');
  const format = useFormatter();
  const [state, formAction, pending] = useActionState(
    adjustCreditAction.bind(null, slug, player.playerUserId),
    null,
  );
  const [direction, setDirection] = useState<'credit' | 'debit'>('credit');

  // The ledger refuses to go below zero, so a debit is capped at what is
  // there. Offering more would be a form that throws on submit.
  const maxDebit = player.creditCents / 100;

  return (
    <form action={formAction} className="grid gap-1.5">
      <Label htmlFor={`amount-${player.playerUserId}`}>{t('field.adjust')}</Label>

      <div className="flex gap-2">
        <select
          name="direction"
          aria-label={t('field.direction')}
          className="border-border-subtle bg-bg-surface h-10 rounded-md border px-3"
          value={direction}
          onChange={(e) => setDirection(e.target.value as 'credit' | 'debit')}
        >
          <option value="credit">{t('direction.credit')}</option>
          <option value="debit" disabled={player.creditCents <= 0}>
            {t('direction.debit')}
          </option>
        </select>
        <Input
          id={`amount-${player.playerUserId}`}
          name="amount"
          type="number"
          step="0.01"
          min="0.01"
          max={direction === 'debit' ? maxDebit : undefined}
          required
        />
      </div>

      {direction === 'debit' && (
        <p className="text-content-muted text-sm">
          {t('field.maxDebit', {
            amount: format.number(maxDebit, { style: 'currency', currency: 'EUR' }),
          })}
        </p>
      )}

      <Label htmlFor={`note-${player.playerUserId}`}>{t('field.note')}</Label>
      <Input
        id={`note-${player.playerUserId}`}
        name="note"
        required
        minLength={8}
        placeholder={t('field.notePlaceholder')}
      />

      <div>
        <Button type="submit" disabled={pending}>
          {t('action.adjust')}
        </Button>
      </div>

      {state && !state.ok && (
        <p role="alert" className="text-content-error text-sm">
          {t(`error.${state.error}`)}
        </p>
      )}
    </form>
  );
}
