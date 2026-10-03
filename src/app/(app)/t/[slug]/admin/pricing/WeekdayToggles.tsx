'use client';

import { useTranslations } from 'next-intl';

import { HIT_AREA_CLASS } from '@/components/ui/hit-area';
import { cn } from '@/lib/cn';

/**
 * The days a rule applies on: a MULTI-select row of toggles, in the vendored
 * ToggleGroup's dress.
 *
 * ═══ WHY NOT THE VENDORED ToggleGroup ITSELF ═══
 *
 * It is single-select by contract — `role="radiogroup"`, one `selected`
 * string, arrows that move the selection — and a rule wants any subset of the
 * week. Driving it with a set would announce seven radios of which several are
 * "checked", which is a lie to a screen reader. The primitive is vendored
 * read-only from upstream, so the multi-select lives here: the same tokens,
 * radius and selected-pill fill as the ToggleGroup, but each day is a toggle
 * button (`aria-pressed`) inside a labelled `fieldset`, which is what a
 * multi-select toggle row is.
 *
 * ═══ WHAT IT POSTS ═══
 *
 * One hidden `dayOfWeek` input per chosen day — the same repeated entries the
 * checkbox group posted, so `actions.ts`'s `form.getAll('dayOfWeek')` reads it
 * unchanged, and no day still means "every day".
 *
 * ═══ FITS A 393 px PHONE ═══
 *
 * Seven equal columns across the field's width below sm, each at least 44 px
 * on a coarse pointer: 7 × 44 px plus the gaps is 338 px, inside the 361 px a
 * 393 px screen leaves the card. A wrapping or scrolling row is the drift the
 * mobile spec measures. From sm the row shrinks to its content.
 */
export function WeekdayToggles({
  label,
  name,
  days,
  selected,
  onChange,
}: {
  label: string;
  name: string;
  /** Engine day numbers, in display order. */
  days: readonly number[];
  selected: readonly number[];
  onChange: (days: number[]) => void;
}) {
  const tDay = useTranslations('common.calendar.weekdayShort');

  const toggle = (d: number) =>
    onChange(
      selected.includes(d)
        ? selected.filter((x) => x !== d)
        : // Kept in display order, so the posted list reads like the row.
          days.filter((x) => x === d || selected.includes(x)),
    );

  return (
    <fieldset className="min-w-0">
      <legend className="text-content-emphasis mb-1.5 text-sm leading-none font-medium tracking-[-0.005em]">
        {label}
      </legend>
      <div className="border-border-subtle bg-bg-default grid w-full grid-cols-7 gap-1 rounded-lg border p-1 sm:inline-grid sm:w-auto">
        {days.map((d) => {
          const on = selected.includes(d);
          return (
            <button
              key={d}
              type="button"
              aria-pressed={on}
              data-day={d}
              onClick={() => toggle(d)}
              className={cn(
                'text-content-emphasis focus-visible:ring-ring focus-visible:ring-offset-background relative flex items-center justify-center rounded-lg border px-3 py-1 text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-offset-2 pointer-coarse:min-h-11 pointer-coarse:px-0',
                HIT_AREA_CLASS,
                on
                  ? 'border-border-subtle bg-bg-muted'
                  : 'hover:text-content-subtle border-transparent transition-colors',
              )}
            >
              {tDay(String(d))}
            </button>
          );
        })}
      </div>
      {selected.map((d) => (
        <input key={d} type="hidden" name={name} value={d} />
      ))}
    </fieldset>
  );
}
