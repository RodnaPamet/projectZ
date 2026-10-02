import { useState } from 'react';

import type { ComboboxOption } from '@/components/ui/combobox';

/**
 * The days of the week as `computePrice` numbers them (0 = Sunday, JS
 * `getDay()`), in the order a Bulgarian week is read: Monday first. Only the
 * ORDER on screen changes — the values posted and stored are the engine's.
 */
export const WEEK = [1, 2, 3, 4, 5, 6, 0] as const;

/**
 * A required single choice: choosing the selected option again is not "clear".
 *
 * The vendored Combobox toggles — re-picking the current option hands back
 * `null`, which would leave the court picker on nothing, the preview without a
 * day, and the rule form posting an empty `mode` the action then reads as "no
 * effect". The same shape as the courts form's (T23).
 */
export function useRequiredChoice(options: readonly ComboboxOption[], initial: string) {
  const [value, setValue] = useState(initial);
  const selected = options.find((o) => o.value === value) ?? null;
  const setSelected = (o: ComboboxOption | null) => {
    if (o) setValue(o.value);
  };
  return { value, selected, setSelected };
}

/**
 * The trigger's accessible name is the field AND its value ("Ден, Чт"). The
 * vendored Combobox names its trigger after the selection alone, which
 * overrides the `<label for>` FormField wires — a screen reader would hear
 * "Чт, combobox" with no hint of what was being chosen.
 */
export function comboProps(label: string, selected: ComboboxOption | null) {
  return {
    matchTriggerWidth: true,
    caret: true,
    buttonProps: {
      className: 'w-full',
      'aria-label': selected ? `${label}, ${String(selected.label)}` : label,
    },
  };
}
