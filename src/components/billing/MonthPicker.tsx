'use client';

import { useId, useMemo } from 'react';
import { useFormatter } from 'next-intl';

import { Combobox, type ComboboxOption } from '@/components/ui/combobox';
import { FormField } from '@/components/ui/form-field';

/**
 * The statement month (#372): the vendored Combobox over `YYYY-MM` values,
 * newest first, each labelled as the month reads in the viewer's language
 * ("октомври 2026").
 *
 * A required choice: re-picking the selected month hands back null in the
 * vendored Combobox, which is ignored here rather than leaving no month. The
 * trigger is named after the field AND the month, as `comboProps` does on the
 * pricing board, so a screen reader hears what is being chosen.
 */
export function MonthPicker({
  label,
  months,
  value,
  onSelect,
}: {
  label: string;
  /** `YYYY-MM`, newest first. */
  months: readonly string[];
  value: string;
  onSelect: (month: string) => void;
}) {
  const format = useFormatter();
  const id = useId();

  const options = useMemo<ComboboxOption[]>(
    () =>
      months.map((m) => {
        const [y, mm] = m.split('-').map(Number) as [number, number];
        return {
          value: m,
          // The 15th at noon UTC is the same month in every zone on Earth.
          label: format.dateTime(new Date(Date.UTC(y, mm - 1, 15, 12)), {
            month: 'long',
            year: 'numeric',
            timeZone: 'UTC',
          }),
        };
      }),
    [months, format],
  );
  const selected = options.find((o) => o.value === value) ?? null;

  return (
    <div className="sm:max-w-xs">
      <FormField label={label}>
        <Combobox
          id={`${id}-month`}
          options={options}
          selected={selected}
          setSelected={(o) => {
            if (o && o.value !== value) onSelect(o.value);
          }}
          matchTriggerWidth
          caret
          buttonProps={{
            className: 'w-full',
            'aria-label': selected ? `${label}, ${String(selected.label)}` : label,
          }}
        />
      </FormField>
    </div>
  );
}
