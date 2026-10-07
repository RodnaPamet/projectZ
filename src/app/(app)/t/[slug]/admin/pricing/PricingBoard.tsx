'use client';

import { startTransition, useActionState, useId, useMemo, useOptimistic, useState } from 'react';
import dynamic from 'next/dynamic';
import { useFormatter, useTranslations } from 'next-intl';

import { computeSpanPrice } from '@/app-layer/usecases/pricing';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Combobox, type ComboboxOption } from '@/components/ui/combobox';
import { EmptyState } from '@/components/ui/empty-state';
import { FieldGroup } from '@/components/ui/field-group';
import { FormField } from '@/components/ui/form-field';
import { InlineNotice } from '@/components/ui/inline-notice';
import { Input } from '@/components/ui/input';
import { StatusBadge } from '@/components/ui/status-badge';
import { Heading } from '@/components/ui/typography';
import { combineNouns, type ResourceNoun } from '@/lib/sports/resource-kinds';

import { deletePricingRuleAction } from './actions';
import { comboProps, useRequiredChoice, WEEK } from './choices';
import { toEngineRules, type PricingRuleView } from './rule-view';

export type { PricingRuleView } from './rule-view';

/**
 * The rule form and the delete confirm load when first opened, not with the
 * route — the same trade the courts board made (T23): most visits read the
 * rules and the preview and never open either.
 */
const RuleForm = dynamic(() => import('./RuleForm'));
const ConfirmDialog = dynamic(() =>
  import('@/components/ui/confirm-dialog').then((m) => m.ConfirmDialog),
);

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
 * The preview is never optimistic about money: it prices the rules the server
 * sent. A rule being deleted drops out of the list at once (below), but the
 * price only moves when the server's revalidated rules arrive.
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
 *
 * ═══ ON THE PRIMITIVES (T24) ═══
 *
 * The court and the preview's day were native `<select>`s painted with
 * `bg-bg-surface`, a class no stylesheet defines; they are the vendored
 * Combobox now. Delete asks through a ConfirmDialog instead of
 * `window.confirm`, whose box ignores the theme and the locale's button labels.
 */

export interface CourtOption {
  id: string;
  name: string;
  /** What the copy calls it (P51): a karting track is a "писта". */
  noun: ResourceNoun;
  /** The price of ONE minBookingMinutes block, not of a booking. */
  basePriceCents: number;
  minBookingMinutes: number;
}

/**
 * A stable reference for "this court has no rules".
 *
 * `rulesByCourt[courtId] ?? []` allocates a fresh array every render, so the
 * preview's `useMemo` dependency changes each time and the memo never holds —
 * it would re-run `computePrice` on every keystroke in an unrelated field.
 */
const NO_RULES: readonly PricingRuleView[] = [];
const NONE_DELETING: ReadonlySet<string> = new Set();

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
  const ids = useId();

  const courtOptions: ComboboxOption[] = courts.map((c) => ({ value: c.id, label: c.name }));
  const courtChoice = useRequiredChoice(courtOptions, courts[0]?.id ?? '');
  const courtId = courtChoice.value;
  const [editingId, setEditingId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  // The rule being asked about outlives the dialog's open flag, so the closing
  // dialog still names it while it plays its exit.
  const [asking, setAsking] = useState<PricingRuleView | null>(null);
  const [confirming, setConfirming] = useState(false);

  // Thursday 19:00, an hour — a time when a peak rule would plausibly apply,
  // so the preview says something on first render instead of showing the base
  // price and looking broken.
  const dayOptions: ComboboxOption[] = WEEK.map((d) => ({
    value: String(d),
    label: tDay(String(d)),
  }));
  const dayChoice = useRequiredChoice(dayOptions, '4');
  const day = Number(dayChoice.value);
  const [from, setFrom] = useState('19:00');
  const [duration, setDuration] = useState(60);

  const court = courts.find((c) => c.id === courtId);
  const rules = rulesByCourt[courtId] ?? NO_RULES;
  // The picker is "Писта" at a karting club and "Корт или писта" at one with
  // both (P51); the empty state speaks of the court picked.
  const nouns = combineNouns(courts.map((c) => c.noun));
  const courtLabel = t(
    nouns === 'track'
      ? 'track.field.court'
      : nouns === 'mixed'
        ? 'mixed.field.court'
        : 'field.court',
  );

  /**
   * ═══ DELETE IS OPTIMISTIC, AND HONEST ABOUT FAILING ═══
   *
   * The rule leaves the list the moment the owner confirms (`useOptimistic`),
   * instead of after the action's round trip AND the revalidated page payload
   * it carries back. That payload is the truth and lands in the same
   * transition, so the optimistic list is replaced by the real one without a
   * flicker.
   *
   * If the action refuses or throws, the transition ends with the props
   * unchanged, the deleting set falls back to empty by itself (that IS the
   * rollback), the rule reappears, and a notice names it. A rule that silently
   * came back would read as a click that missed.
   */
  const [deleting, markDeleting] = useOptimistic(NONE_DELETING, (s, id: string) =>
    new Set(s).add(id),
  );
  const [failedName, deleteRule, deletePending] = useActionState(
    async (_prev: string | null, rule: PricingRuleView): Promise<string | null> => {
      markDeleting(rule.id);
      try {
        const result = await deletePricingRuleAction(slug, rule.id);
        return result.ok ? null : rule.name;
      } catch {
        return rule.name;
      }
    },
    null,
  );
  const visible = useMemo(
    () => (deleting.size === 0 ? rules : rules.filter((r) => !deleting.has(r.id))),
    [rules, deleting],
  );

  const money = (cents: number) =>
    format.number(cents / 100, { style: 'currency', currency: 'EUR' });

  // Prices the SERVER's rules, not `visible`: money is never optimistic.
  const preview = useMemo(() => {
    if (!court) return null;
    const [h, m] = from.split(':').map((n) => Number.parseInt(n, 10));
    const start = (h ?? 0) * 60 + (m ?? 0);
    // ═══ PER BLOCK, BECAUSE THAT IS WHAT THE BOOKING ROUTE CHARGES ═══
    //
    // `basePriceCents` prices ONE `minBookingMinutes` block. This called
    // `computePrice` once for the whole span, so a two-hour booking previewed
    // at the price of one hour — and a peak rule covering only the second hour
    // was reported as "not applied", which defeats the question this screen
    // exists to answer.
    //
    // `computeSpanPrice` is the same loop `quoteBooking` runs, shared rather
    // than reimplemented, so the two cannot drift apart again. The rules go
    // back through `toEngineRules`: the engine reads `conditionsJson`, and a
    // view handed over by cast carried none, so every rule matched every day
    // (#350).
    const units = Math.max(1, Math.floor(duration / court.minBookingMinutes));
    return computeSpanPrice(toEngineRules(rules), {
      basePriceCents: court.basePriceCents,
      localDayOfWeek: day,
      localStartMinutes: start,
      unitMinutes: court.minBookingMinutes,
      units,
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
    return (
      <div data-perf-ready>
        <EmptyState title={t('noCourts.title')} description={t('noCourts.description')} />
      </div>
    );
  }

  return (
    // data-perf-ready: the perf harness's READY marker (docs/perf/README.md).
    // Its pricing row waits for this element to contain the first court's
    // first rule name, so the rule list stays inside it.
    <div data-perf-ready className="gap-section grid lg:grid-cols-[2fr_1fr]">
      <div className="gap-default grid content-start">
        <div className="gap-tight grid sm:max-w-xs">
          <FormField label={courtLabel}>
            <Combobox
              id={`${ids}-court`}
              options={courtOptions}
              selected={courtChoice.selected}
              setSelected={(o) => {
                courtChoice.setSelected(o);
                setEditingId(null);
                setAdding(false);
              }}
              {...comboProps(courtLabel, courtChoice.selected)}
            />
          </FormField>
          <p className="text-content-muted text-sm">
            {t('basePrice', { price: money(court?.basePriceCents ?? 0) })}
          </p>
        </div>

        {failedName !== null && !deletePending && (
          <InlineNotice variant="error">{t('delete.failed', { name: failedName })}</InlineNotice>
        )}

        {visible.length === 0 && !adding ? (
          <EmptyState
            title={t(court?.noun === 'track' ? 'track.empty.title' : 'empty.title')}
            description={t('empty.description')}
          />
        ) : (
          <ul className="gap-tight grid">
            {visible.map((r) => {
              // Applied to ANY block, not to the span. A rule covering
              // 18:00–22:00 wins the second hour of a 17:00 two-hour booking
              // and loses the first, so "did it apply?" has no single answer.
              const traced = preview ? { matched: preview.appliedRuleIds.includes(r.id) } : null;
              return (
                <Card
                  as="li"
                  key={r.id}
                  elevation="flat"
                  density="compact"
                  className="bg-bg-default"
                  data-rule-id={r.id}
                >
                  {editingId === r.id ? (
                    <RuleForm
                      slug={slug}
                      courtId={courtId}
                      rule={r}
                      onDone={() => setEditingId(null)}
                    />
                  ) : (
                    <>
                      <div className="gap-compact flex items-start justify-between">
                        <div className="min-w-0">
                          <span className="text-content-muted mr-2 text-sm tabular-nums">
                            {r.priority}
                          </span>
                          <span className="font-medium">{r.name}</span>
                          <p className="text-content-muted text-sm">
                            {conditionSummary(r.conditions)}
                          </p>
                        </div>
                        <div className="gap-tight flex shrink-0 items-center">
                          <span className="tabular-nums">{effect(r)}</span>
                          {traced && (
                            <StatusBadge variant={traced.matched ? 'success' : 'neutral'}>
                              {traced.matched ? t('trace.applied') : t('trace.notApplied')}
                            </StatusBadge>
                          )}
                        </div>
                      </div>
                      <div className="mt-compact gap-tight flex">
                        <Button type="button" variant="ghost" onClick={() => setEditingId(r.id)}>
                          {t('action.edit')}
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          onClick={() => {
                            setAsking(r);
                            setConfirming(true);
                          }}
                        >
                          {t('action.delete')}
                        </Button>
                      </div>
                    </>
                  )}
                </Card>
              );
            })}
          </ul>
        )}

        <div>
          {adding ? (
            <Card density="compact" elevation="flat" className="bg-bg-default">
              <RuleForm slug={slug} courtId={courtId} onDone={() => setAdding(false)} />
            </Card>
          ) : (
            <Button type="button" onClick={() => setAdding(true)}>
              {t('action.add')}
            </Button>
          )}
        </div>
      </div>

      <Card as="aside" density="compact" className="h-fit">
        <Heading level={2} className="mb-compact text-base font-medium">
          {t('preview.title')}
        </Heading>

        <div className="gap-compact grid">
          <FormField label={t('preview.day')}>
            <Combobox
              id={`${ids}-pv-day`}
              options={dayOptions}
              selected={dayChoice.selected}
              setSelected={dayChoice.setSelected}
              {...comboProps(t('preview.day'), dayChoice.selected)}
            />
          </FormField>

          <FieldGroup columns={2}>
            <FormField label={t('preview.from')}>
              <Input
                id={`${ids}-pv-from`}
                type="time"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
              />
            </FormField>
            <FormField label={t('preview.duration')}>
              <Input
                id={`${ids}-pv-dur`}
                type="number"
                // The booking route refuses a duration that is not a whole
                // number of blocks, so the form must not offer one.
                min={court?.minBookingMinutes ?? 15}
                step={court?.minBookingMinutes ?? 15}
                value={duration}
                onChange={(e) => setDuration(Number(e.target.value))}
              />
            </FormField>
          </FieldGroup>
        </div>

        {preview && (
          <div className="border-border-subtle mt-default pt-default border-t">
            <p className="text-2xl font-semibold tabular-nums">{money(preview.finalPriceCents)}</p>
            <p className="text-content-muted text-sm">
              {t('preview.units', {
                units: preview.units,
                minutes: court?.minBookingMinutes ?? 0,
              })}
            </p>
            <p className="text-content-muted text-sm">
              {preview.appliedRuleIds.length === 0
                ? t('preview.base')
                : preview.appliedRuleIds.length === 1
                  ? t('preview.via', {
                      name: rules.find((r) => r.id === preview.appliedRuleIds[0])?.name ?? '',
                    })
                  : // Different rules won different blocks; naming one would be
                    // a lie about the others.
                    t('preview.mixed')}
            </p>
          </div>
        )}
      </Card>

      {/* Mounted from the first ask on, never before: a dynamic component
          rendered at all is fetched at once. Kept mounted after, so closing
          plays the dialog's exit rather than vanishing. */}
      {asking && (
        <ConfirmDialog
          showModal={confirming}
          setShowModal={setConfirming}
          tone="danger"
          title={t('delete.title')}
          description={t('delete.confirm', { name: asking.name })}
          confirmLabel={t('action.delete')}
          cancelLabel={t('action.cancel')}
          // Returns nothing, so the dialog closes at once and the rule leaves
          // the list under it — awaiting the action here would hold the dialog
          // open for the round trip and spend the optimistic update on a
          // spinner.
          onConfirm={() => startTransition(() => deleteRule(asking))}
        />
      )}
    </div>
  );
}
