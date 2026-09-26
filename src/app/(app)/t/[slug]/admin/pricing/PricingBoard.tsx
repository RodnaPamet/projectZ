'use client';

import { useActionState, useMemo, useState } from 'react';
import { useFormatter, useTranslations } from 'next-intl';

import { computePrice, type PricingRuleRow } from '@/app-layer/usecases/pricing';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { StatusBadge } from '@/components/ui/status-badge';

import {
  createPricingRuleAction,
  deletePricingRuleAction,
  updatePricingRuleAction,
} from './actions';

/**
 * The pricing screen: the rules for a court, and what they do.
 *
 * ═══ THE PREVIEW RUNS THE REAL ENGINE ═══
 *
 * `computePrice` is a pure function — its only import is an erased type, and it
 * reads the multiplier through `Number()`. So it runs here, in the browser,
 * against the same rules the server will use.
 *
 * That matters more than the instant feedback. A preview that reimplemented the
 * rules would agree with the engine right up until somebody changed one of
 * them, and then it would confidently show the wrong price — which is worse
 * than no preview, because a club would trust it.
 *
 * ═══ WHY IT SHOWS THE RULES THAT DID NOT WIN ═══
 *
 * `computePrice` returns a trace of every rule it considered. "Why is Thursday
 * evening not the peak price I set?" is the question this screen exists to
 * answer, and it is unanswerable from the final number alone.
 *
 * The trace's `reason` strings are generated in English by the engine, so they
 * are NOT rendered — a Bulgarian club would get English prose. The conditions
 * are shown instead, translated, next to each rule: the reader can see that a
 * rule wanted Saturday and it is Thursday.
 */

export interface PricingRuleView {
  id: string;
  name: string;
  priority: number;
  /** Already narrowed from Prisma.Decimal at the server boundary. */
  multiplier: number | null;
  fixedPriceCents: number | null;
  conditions: {
    dayOfWeek?: number[];
    timeRange?: { from: string; to: string };
    playerTags?: string[];
    membershipLevel?: string;
  };
}

export interface CourtOption {
  id: string;
  name: string;
  basePriceCents: number;
}

const DAYS = [0, 1, 2, 3, 4, 5, 6] as const;

/**
 * A stable reference for "this court has no rules".
 *
 * `rulesByCourt[courtId] ?? []` allocates a fresh array every render, so the
 * preview's `useMemo` dependency changes each time and the memo never holds —
 * it would re-run `computePrice` on every keystroke in an unrelated field.
 */
const NO_RULES: readonly PricingRuleView[] = [];

export function PricingBoard({
  slug,
  courts,
  rulesByCourt,
}: {
  slug: string;
  courts: readonly CourtOption[];
  rulesByCourt: Readonly<Record<string, readonly PricingRuleView[]>>;
}) {
  const t = useTranslations('admin.pricing');
  const tDay = useTranslations('common.calendar.weekdayShort');
  const format = useFormatter();

  const [courtId, setCourtId] = useState(courts[0]?.id ?? '');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  // Thursday 19:00, an hour — a time when a peak rule would plausibly apply,
  // so the preview says something on first render instead of showing the base
  // price and looking broken.
  const [day, setDay] = useState(4);
  const [from, setFrom] = useState('19:00');
  const [duration, setDuration] = useState(60);

  const court = courts.find((c) => c.id === courtId);
  const rules = rulesByCourt[courtId] ?? NO_RULES;

  const money = (cents: number) =>
    format.number(cents / 100, { style: 'currency', currency: 'EUR' });

  const preview = useMemo(() => {
    if (!court) return null;
    const [h, m] = from.split(':').map((n) => Number.parseInt(n, 10));
    const start = (h ?? 0) * 60 + (m ?? 0);
    return computePrice(rules as unknown as PricingRuleRow[], {
      basePriceCents: court.basePriceCents,
      localDayOfWeek: day,
      localStartMinutes: start,
      localEndMinutes: start + duration,
    });
  }, [court, rules, day, from, duration]);

  const conditionSummary = (c: PricingRuleView['conditions']) => {
    const parts: string[] = [];
    if (c.dayOfWeek?.length) parts.push(c.dayOfWeek.map((d) => tDay(String(d))).join(', '));
    if (c.timeRange) parts.push(`${c.timeRange.from}–${c.timeRange.to}`);
    if (c.membershipLevel) parts.push(t('condition.level', { level: c.membershipLevel }));
    if (c.playerTags?.length) parts.push(c.playerTags.join(', '));
    return parts.length > 0 ? parts.join(' · ') : t('condition.always');
  };

  const effect = (r: PricingRuleView) =>
    r.fixedPriceCents !== null ? money(r.fixedPriceCents) : `×${r.multiplier ?? 1}`;

  if (courts.length === 0) {
    return <EmptyState title={t('noCourts.title')} description={t('noCourts.description')} />;
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[2fr_1fr]">
      <div>
        <div className="mb-4 grid gap-1.5 sm:max-w-xs">
          <Label htmlFor="courtId">{t('field.court')}</Label>
          <select
            id="courtId"
            className="border-border-subtle bg-bg-surface h-10 rounded-md border px-3"
            value={courtId}
            onChange={(e) => {
              setCourtId(e.target.value);
              setEditingId(null);
              setAdding(false);
            }}
          >
            {courts.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          <p className="text-content-muted text-sm">
            {t('basePrice', { price: money(court?.basePriceCents ?? 0) })}
          </p>
        </div>

        {rules.length === 0 && !adding ? (
          <EmptyState title={t('empty.title')} description={t('empty.description')} />
        ) : (
          <ul className="grid gap-2">
            {rules.map((r) => {
              const traced = preview?.ruleTrace.find((x) => x.ruleId === r.id);
              return (
                <li key={r.id} className="border-border-subtle rounded-lg border p-3">
                  {editingId === r.id ? (
                    <RuleForm
                      slug={slug}
                      courtId={courtId}
                      rule={r}
                      onDone={() => setEditingId(null)}
                    />
                  ) : (
                    <>
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <span className="text-content-muted mr-2 text-sm tabular-nums">
                            {r.priority}
                          </span>
                          <span className="font-medium">{r.name}</span>
                          <p className="text-content-muted text-sm">
                            {conditionSummary(r.conditions)}
                          </p>
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="tabular-nums">{effect(r)}</span>
                          {traced && (
                            <StatusBadge variant={traced.matched ? 'success' : 'neutral'}>
                              {traced.matched ? t('trace.applied') : t('trace.notApplied')}
                            </StatusBadge>
                          )}
                        </div>
                      </div>
                      <div className="mt-2 flex gap-2">
                        <Button type="button" variant="ghost" onClick={() => setEditingId(r.id)}>
                          {t('action.edit')}
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          onClick={async () => {
                            if (window.confirm(t('delete.confirm', { name: r.name }))) {
                              await deletePricingRuleAction(slug, r.id);
                            }
                          }}
                        >
                          {t('action.delete')}
                        </Button>
                      </div>
                    </>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        <div className="mt-4">
          {adding ? (
            <RuleForm slug={slug} courtId={courtId} onDone={() => setAdding(false)} />
          ) : (
            <Button type="button" onClick={() => setAdding(true)}>
              {t('action.add')}
            </Button>
          )}
        </div>
      </div>

      <aside className="border-border-subtle bg-bg-surface h-fit rounded-lg border p-4">
        <h2 className="mb-3 font-medium">{t('preview.title')}</h2>

        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="pv-day">{t('preview.day')}</Label>
            <select
              id="pv-day"
              className="border-border-subtle bg-bg-surface h-10 rounded-md border px-3"
              value={day}
              onChange={(e) => setDay(Number(e.target.value))}
            >
              {DAYS.map((d) => (
                <option key={d} value={d}>
                  {tDay(String(d))}
                </option>
              ))}
            </select>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="pv-from">{t('preview.from')}</Label>
              <Input
                id="pv-from"
                type="time"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="pv-dur">{t('preview.duration')}</Label>
              <Input
                id="pv-dur"
                type="number"
                min={15}
                step={15}
                value={duration}
                onChange={(e) => setDuration(Number(e.target.value))}
              />
            </div>
          </div>
        </div>

        {preview && (
          <div className="border-border-subtle mt-4 border-t pt-4">
            <p className="text-2xl font-semibold tabular-nums">{money(preview.finalPriceCents)}</p>
            <p className="text-content-muted text-sm">
              {preview.appliedRuleId
                ? t('preview.via', {
                    name: rules.find((r) => r.id === preview.appliedRuleId)?.name ?? '',
                  })
                : t('preview.base')}
            </p>
          </div>
        )}
      </aside>
    </div>
  );
}

/** Create or edit — one form, because the fields and the rules are identical. */
function RuleForm({
  slug,
  courtId,
  rule,
  onDone,
}: {
  slug: string;
  courtId: string;
  rule?: PricingRuleView;
  onDone: () => void;
}) {
  const t = useTranslations('admin.pricing');
  const tDay = useTranslations('common.calendar.weekdayShort');
  const editing = Boolean(rule);

  const [state, formAction, pending] = useActionState(
    editing
      ? updatePricingRuleAction.bind(null, slug, rule!.id)
      : createPricingRuleAction.bind(null, slug),
    null,
  );

  const [mode, setMode] = useState<'multiplier' | 'fixed'>(
    rule?.fixedPriceCents !== null && rule?.fixedPriceCents !== undefined ? 'fixed' : 'multiplier',
  );

  if (state?.ok) onDone();

  return (
    <form action={formAction} className="grid gap-3">
      <input type="hidden" name="resourceId" value={courtId} />

      <div className="grid gap-3 sm:grid-cols-[2fr_1fr]">
        <div className="grid gap-1.5">
          <Label htmlFor="name">{t('field.name')}</Label>
          <Input id="name" name="name" required maxLength={80} defaultValue={rule?.name} />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="priority">{t('field.priority')}</Label>
          <Input
            id="priority"
            name="priority"
            type="number"
            min={0}
            max={1000}
            required
            defaultValue={rule?.priority ?? 100}
          />
        </div>
      </div>

      <fieldset>
        <legend className="text-content-muted mb-1.5 text-sm">{t('field.days')}</legend>
        <div className="flex flex-wrap gap-3">
          {DAYS.map((d) => (
            <label key={d} className="flex items-center gap-1.5 text-sm">
              <input
                type="checkbox"
                name="dayOfWeek"
                value={d}
                defaultChecked={rule?.conditions.dayOfWeek?.includes(d)}
              />
              {tDay(String(d))}
            </label>
          ))}
        </div>
      </fieldset>

      <div className="grid grid-cols-2 gap-3">
        <div className="grid gap-1.5">
          <Label htmlFor="from">{t('field.from')}</Label>
          <Input
            id="from"
            name="from"
            type="time"
            defaultValue={rule?.conditions.timeRange?.from}
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="to">{t('field.to')}</Label>
          <Input id="to" name="to" type="time" defaultValue={rule?.conditions.timeRange?.to} />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="grid gap-1.5">
          <Label htmlFor="mode">{t('field.effect')}</Label>
          <select
            id="mode"
            name="mode"
            className="border-border-subtle bg-bg-surface h-10 rounded-md border px-3"
            value={mode}
            onChange={(e) => setMode(e.target.value as 'multiplier' | 'fixed')}
          >
            <option value="multiplier">{t('effect.multiplier')}</option>
            <option value="fixed">{t('effect.fixed')}</option>
          </select>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="amount">
            {mode === 'fixed' ? t('field.fixedPrice') : t('field.multiplier')}
          </Label>
          <Input
            id="amount"
            name="amount"
            type="number"
            step={mode === 'fixed' ? '0.01' : '0.05'}
            min={0}
            required
            defaultValue={
              mode === 'fixed'
                ? ((rule?.fixedPriceCents ?? 0) / 100).toFixed(2)
                : (rule?.multiplier ?? 1.25)
            }
          />
        </div>
      </div>

      {state && !state.ok && (
        <p role="alert" className="text-content-error text-sm">
          {state.error}
        </p>
      )}

      <div className="flex gap-2">
        <Button type="submit" disabled={pending}>
          {editing ? t('action.save') : t('action.add')}
        </Button>
        <Button type="button" variant="ghost" onClick={onDone}>
          {t('action.cancel')}
        </Button>
      </div>
    </form>
  );
}
