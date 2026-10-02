'use client';

import { useActionState, useId, useState } from 'react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { Combobox, type ComboboxOption } from '@/components/ui/combobox';
import { FieldGroup } from '@/components/ui/field-group';
import { FormField } from '@/components/ui/form-field';
import { InlineNotice } from '@/components/ui/inline-notice';
import { Input } from '@/components/ui/input';

import { createPricingRuleAction, updatePricingRuleAction } from './actions';
import { comboProps, useRequiredChoice, WEEK } from './choices';
import type { PricingRuleView } from './PricingBoard';
import { WeekdayToggles } from './WeekdayToggles';

/**
 * Create or edit a rule — one form, because the fields and the rules are
 * identical.
 *
 * ═══ ON THE PRIMITIVES (T24) ═══
 *
 * The effect was a native `<select>` (an OS wheel on a phone that ignores
 * every token, and posted `bg-bg-surface`, a class no stylesheet defines); it
 * is the vendored Combobox now, posting `mode` through its hidden input as
 * the select did. The weekday checkboxes are a row of toggles
 * (`WeekdayToggles`) posting one `dayOfWeek` per chosen day, which is exactly
 * what the checkbox group posted, so `actions.ts` reads the same FormData.
 * The times stay native `type="time"`: the browser's own time field is the
 * one native control that is better than anything we would build, and it
 * styles from the Input primitive.
 *
 * ═══ WHAT THIS DOES NOT VALIDATE ═══
 *
 * Anything. The action re-parses every field with Zod, and the error shown is
 * the one it returned, so what the user reads is what stopped the write.
 */
export default function RuleForm({
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
  const ids = useId();
  const editing = Boolean(rule);

  const [state, formAction, pending] = useActionState(
    editing
      ? updatePricingRuleAction.bind(null, slug, rule!.id)
      : createPricingRuleAction.bind(null, slug),
    null,
  );

  const modeOptions: ComboboxOption[] = [
    { value: 'multiplier', label: t('effect.multiplier') },
    { value: 'fixed', label: t('effect.fixed') },
  ];
  const mode = useRequiredChoice(
    modeOptions,
    rule?.fixedPriceCents !== null && rule?.fixedPriceCents !== undefined ? 'fixed' : 'multiplier',
  );
  const fixed = mode.value === 'fixed';

  const [days, setDays] = useState<readonly number[]>(rule?.conditions.dayOfWeek ?? []);

  // A successful submit closes the form. `state` only changes when the action
  // returns, so there is nothing to synchronise in an effect.
  if (state?.ok) onDone();

  return (
    <form action={formAction} className="gap-default grid">
      <input type="hidden" name="resourceId" value={courtId} />

      <FieldGroup columns={2}>
        <FormField label={t('field.name')}>
          <Input id={`${ids}-name`} name="name" required maxLength={80} defaultValue={rule?.name} />
        </FormField>
        <FormField label={t('field.priority')}>
          <Input
            id={`${ids}-priority`}
            name="priority"
            type="number"
            min={0}
            max={1000}
            required
            defaultValue={rule?.priority ?? 100}
          />
        </FormField>
      </FieldGroup>

      <WeekdayToggles
        label={t('field.days')}
        name="dayOfWeek"
        days={WEEK}
        selected={days}
        onChange={setDays}
      />

      <FieldGroup columns={2}>
        <FormField label={t('field.from')}>
          <Input
            id={`${ids}-from`}
            name="from"
            type="time"
            defaultValue={rule?.conditions.timeRange?.from}
          />
        </FormField>
        <FormField label={t('field.to')}>
          <Input
            id={`${ids}-to`}
            name="to"
            type="time"
            defaultValue={rule?.conditions.timeRange?.to}
          />
        </FormField>
      </FieldGroup>

      <FieldGroup columns={2}>
        <FormField label={t('field.effect')}>
          <Combobox
            id={`${ids}-mode`}
            name="mode"
            required
            options={modeOptions}
            selected={mode.selected}
            setSelected={mode.setSelected}
            {...comboProps(t('field.effect'), mode.selected)}
          />
        </FormField>
        <FormField label={fixed ? t('field.fixedPrice') : t('field.multiplier')}>
          <Input
            // Keyed by the mode: `defaultValue` applies only on mount, so
            // switching to a fixed price kept showing "1.25" — read as
            // €1.25 — until the field was cleared by hand.
            key={mode.value}
            id={`${ids}-amount`}
            name="amount"
            type="number"
            step={fixed ? '0.01' : '0.05'}
            min={0}
            required
            defaultValue={
              fixed ? ((rule?.fixedPriceCents ?? 0) / 100).toFixed(2) : (rule?.multiplier ?? 1.25)
            }
          />
        </FormField>
      </FieldGroup>

      {state && !state.ok && <InlineNotice variant="error">{state.error}</InlineNotice>}

      <div className="gap-tight flex">
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
