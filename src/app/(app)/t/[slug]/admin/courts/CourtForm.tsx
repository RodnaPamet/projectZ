'use client';

import { useActionState, useId, useState } from 'react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { Combobox, type ComboboxOption } from '@/components/ui/combobox';
import { FieldGroup } from '@/components/ui/field-group';
import { FormField } from '@/components/ui/form-field';
import { InlineNotice } from '@/components/ui/inline-notice';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { bookableSports, isSportKey } from '@/lib/sports/registry';
import { isResourceType, RESOURCE_KINDS } from '@/lib/sports/resource-kinds';
import { nounForSport } from '@/lib/sports/resources';

import { createCourtAction, updateCourtAction } from './actions';

/**
 * One form for adding a court and for editing one.
 *
 * ═══ WHY THE SAME COMPONENT FOR BOTH ═══
 *
 * The fields are identical and the validation is identical. Two components
 * would be two places for the booking-window rules to drift out of agreement
 * with the server, and the server is the one that decides.
 *
 * The two schemas are NOT the same shape though, and the difference is not
 * only `venueId`: `courtCreateSchema` also carries `resourceType`, which
 * `courtUpdateSchema` has no key for and `updateCourtAction` never reads. A
 * field added to this form on the assumption that both accept it would save on
 * create and silently do nothing on edit.
 *
 * ═══ WHAT THIS DOES NOT VALIDATE ═══
 *
 * Anything. `required` and `type="number"` are conveniences for the person
 * typing; none of it reaches the server, and the action re-parses every field
 * with Zod regardless. The error shown here is the one the server returned, so
 * what the user reads is what actually stopped the write.
 *
 * ═══ NO NATIVE SELECT (T23) ═══
 *
 * Venue, sport and surface were native `<select>`s whose options read PADEL and
 * ARTIFICIAL_GRASS — the Prisma enum, in English, on a Bulgarian screen. On a
 * phone a native select is an OS wheel that ignores every token. They are the
 * vendored Combobox now, labelled from `sports.*` and
 * `admin.courts.surface.*`. A Combobox posts through a hidden input named like
 * the select it replaced, so the actions read the same FormData keys; the
 * indoor Switch posts `on` exactly as the checkbox did.
 *
 * Surface is a Combobox rather than a ToggleGroup: seven segments do not fit a
 * 393 px row, and a ToggleGroup that wraps or scrolls is the drift the mobile
 * specs exist to catch.
 */

export interface CourtFormValues {
  id?: string;
  name: string;
  sport: string;
  /** What it is stored as (P51): decides whether the copy says корт or писта. */
  resourceType?: string;
  surface: string;
  isIndoor: boolean;
  capacity: number;
  basePriceCents: number;
  minBookingMinutes: number;
  maxBookingMinutes: number;
  slotStepMinutes: number;
}

/**
 * The sports this form offers: the registry's bookable sports played on a
 * COURT, and those with an EXCLUSIVE resource type of their own (karting, on a
 * TRACK). The server picks the type from the sport (`defaultResourceType`,
 * `resourceTypeAfter`), so the form never asks for one.
 *
 * It was a hand-written list of six, one of them SQUASH, which was not a
 * `SportType` at all then: `sportSchema` refused it, so picking it failed the
 * save with an English Zod message. Squash is a real sport since P51 and
 * arrives here from the registry, as every sport added later will. FOOTBALL is
 * a FIELD in the registry. A court already saved under any other sport keeps
 * it on edit (see `sportKeys` below).
 */
const COURT_SPORTS: readonly string[] = bookableSports()
  .filter((s) => s.resourceType === 'COURT' || RESOURCE_KINDS[s.resourceType].exclusive)
  .map((s) => s.key);
const SURFACES = [
  'CLAY',
  'HARD',
  'GRASS',
  'ARTIFICIAL_GRASS',
  'CARPET',
  'WOOD',
  'CONCRETE',
] as const;

/**
 * A required single-select: choosing the selected option again is not "clear".
 *
 * The vendored Combobox toggles — re-picking the current option hands back
 * `null`, which would post an empty value the server then refuses. A court
 * always has a sport, a surface and (when created) a venue.
 */
function useRequiredChoice(options: readonly ComboboxOption[], initial: string | undefined) {
  const [value, setValue] = useState(initial ?? options[0]?.value ?? '');
  const selected = options.find((o) => o.value === value) ?? null;
  const setSelected = (o: ComboboxOption | null) => {
    if (o) setValue(o.value);
  };
  return { selected, setSelected };
}

export function CourtForm({
  slug,
  venues,
  court,
  onDone,
}: {
  slug: string;
  /** Only needed when creating — an edit cannot move a court between sites. */
  venues?: ReadonlyArray<{ id: string; name: string }>;
  court?: CourtFormValues;
  onDone?: () => void;
}) {
  const t = useTranslations('admin.courts');
  const tSport = useTranslations('sports');
  const editing = Boolean(court?.id);
  const ids = useId();

  const [state, formAction, pending] = useActionState(
    editing ? updateCourtAction.bind(null, slug, court!.id!) : createCourtAction.bind(null, slug),
    null,
  );

  const venueOptions: ComboboxOption[] = (venues ?? []).map((v) => ({
    value: v.id,
    label: v.name,
  }));
  // A court saved under a sport outside COURT_SPORTS keeps it on edit. The
  // native select silently showed PADEL for one, and saving the form moved
  // the court to padel without anyone choosing that.
  const sportKeys: readonly string[] =
    court && !COURT_SPORTS.includes(court.sport) ? [...COURT_SPORTS, court.sport] : COURT_SPORTS;
  const sportOptions: ComboboxOption[] = sportKeys.map((s) => ({
    value: s,
    label: tSport(s as never),
  }));
  const surfaceOptions: ComboboxOption[] = SURFACES.map((s) => ({
    value: s,
    label: t(`surface.${s}`),
  }));

  const venue = useRequiredChoice(venueOptions, venues?.[0]?.id);
  const sport = useRequiredChoice(sportOptions, court?.sport ?? 'PADEL');
  const surface = useRequiredChoice(surfaceOptions, court?.surface ?? 'ARTIFICIAL_GRASS');

  // The copy follows the sport picked, as the saved type will (P51): karting
  // makes a TRACK, so the switch reads "Закрита" and the button "Добавяне на
  // писта" before anything is saved.
  const picked = sport.selected?.value;
  const noun =
    picked && isSportKey(picked)
      ? nounForSport(picked, isResourceType(court?.resourceType) ? court.resourceType : undefined)
      : 'court';

  // A successful submit closes the form. Checked on render rather than in an
  // effect: `state` only changes when the action returns, so there is nothing
  // to synchronise.
  if (state?.ok && onDone) onDone();

  /**
   * The trigger's accessible name is the field AND its value ("Спорт, Падел").
   * The vendored Combobox names its trigger after the selection alone, which
   * overrides the `<label for>` FormField wires — a screen reader heard
   * "Падел, combobox" with no hint of what was being chosen.
   */
  const comboProps = (label: string, selected: ComboboxOption | null) => ({
    matchTriggerWidth: true,
    caret: true,
    buttonProps: {
      className: 'w-full',
      'aria-label': selected ? `${label}, ${String(selected.label)}` : label,
    },
  });

  return (
    // data-perf-write="…": the perf harness's WRITE markers (docs/perf/README.md,
    // the staff-write journey). It renames a court here and saves it back, and
    // counts what the revalidating action costs on the wire. A rewrite of this
    // form keeps all three, or the journey stops with the marker it missed.
    <form action={formAction} data-perf-write="form" className="gap-default grid">
      {!editing && venues && (
        <FormField label={t('field.venue')}>
          <Combobox
            id={`${ids}-venue`}
            name="venueId"
            required
            options={venueOptions}
            selected={venue.selected}
            setSelected={venue.setSelected}
            {...comboProps(t('field.venue'), venue.selected)}
          />
        </FormField>
      )}

      <FormField label={t('field.name')}>
        <Input
          id={`${ids}-name`}
          name="name"
          required
          maxLength={80}
          defaultValue={court?.name}
          data-perf-write="name"
        />
      </FormField>

      <FieldGroup columns={2}>
        <FormField label={t('field.sport')}>
          <Combobox
            id={`${ids}-sport`}
            name="sport"
            required
            options={sportOptions}
            selected={sport.selected}
            setSelected={sport.setSelected}
            {...comboProps(t('field.sport'), sport.selected)}
          />
        </FormField>

        <FormField label={t('field.surface')}>
          <Combobox
            id={`${ids}-surface`}
            name="surface"
            required
            options={surfaceOptions}
            selected={surface.selected}
            setSelected={surface.setSelected}
            {...comboProps(t('field.surface'), surface.selected)}
          />
        </FormField>
      </FieldGroup>

      <FieldGroup columns={2}>
        <FormField label={t('field.capacity')}>
          <Input
            id={`${ids}-capacity`}
            name="capacity"
            type="number"
            min={1}
            max={64}
            required
            defaultValue={court?.capacity ?? 4}
          />
        </FormField>

        {/* Cents, and the label says so — a club typing 24 and getting
            €0.24 is the predictable failure of a field called "price". */}
        <FormField label={t('field.basePriceCents')}>
          <Input
            id={`${ids}-basePriceCents`}
            name="basePriceCents"
            type="number"
            min={0}
            required
            defaultValue={court?.basePriceCents ?? 2400}
          />
        </FormField>
      </FieldGroup>

      <FieldGroup title={t('field.bookingWindow')} columns={3}>
        {(
          [
            ['minBookingMinutes', court?.minBookingMinutes ?? 60],
            ['maxBookingMinutes', court?.maxBookingMinutes ?? 180],
            ['slotStepMinutes', court?.slotStepMinutes ?? 30],
          ] as const
        ).map(([key, value]) => (
          <FormField key={key} label={t(`field.${key}`)}>
            <Input
              id={`${ids}-${key}`}
              name={key}
              type="number"
              min={5}
              required
              defaultValue={value}
            />
          </FormField>
        ))}
      </FieldGroup>

      {/* The whole row is the target: the label toggles the switch, and the
          row is 44 px tall, which the 20 px track alone is not. */}
      <div className="gap-tight flex min-h-11 items-center">
        <Switch id={`${ids}-indoor`} name="isIndoor" defaultChecked={court?.isIndoor} />
        <Label htmlFor={`${ids}-indoor`} className="cursor-pointer py-3">
          {t(noun === 'track' ? 'track.setting.indoor' : 'setting.indoor')}
        </Label>
      </div>

      {state && !state.ok && <InlineNotice variant="error">{state.error}</InlineNotice>}

      <div className="gap-tight flex">
        <Button type="submit" disabled={pending} data-perf-write="submit">
          {editing ? t('action.save') : t(noun === 'track' ? 'track.action.add' : 'action.add')}
        </Button>
        {onDone && (
          <Button type="button" variant="ghost" onClick={onDone}>
            {t('action.cancel')}
          </Button>
        )}
      </div>
    </form>
  );
}
