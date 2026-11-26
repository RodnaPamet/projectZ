'use client';

import { useId, useState } from 'react';
import { useTranslations } from 'next-intl';

import { clampRadiusKm, RADIUS_MAX_KM, RADIUS_MIN_KM } from '@/lib/venues/near';

/**
 * «В радиус 25 км», 1–100 km (#697, owner 2026-11-13), under the list's
 * chips while «Близо до мен» is on, as on the phone.
 *
 * The figure follows the thumb; the list follows on RELEASE (the pointer let
 * go, a key let go, or focus leaving), as the phone reads its slider "on
 * release": a drag from 5 to 80 km is one read, not seventy-five.
 */
export function RadiusSlider({
  radiusKm,
  commitAction,
}: {
  radiusKm: number;
  /** The new reach, once the person lets go. */
  commitAction: (km: number) => void;
}) {
  const t = useTranslations('venues.near');
  const id = useId();
  const [draft, setDraft] = useState<number | null>(null);
  const shown = draft ?? radiusKm;

  function commit() {
    if (draft === null) return;
    const km = clampRadiusKm(draft);
    setDraft(null);
    if (km !== radiusKm) commitAction(km);
  }

  return (
    <div className="mt-3 flex flex-col gap-1" data-testid="venues-radius">
      <label htmlFor={id} className="text-content-emphasis text-sm font-semibold tabular-nums">
        {t('radius', { km: shown })}
      </label>
      <div className="flex items-center gap-3">
        <span aria-hidden="true" className="text-content-muted text-xs tabular-nums">
          {RADIUS_MIN_KM}
        </span>
        <input
          id={id}
          type="range"
          className="radius-slider"
          min={RADIUS_MIN_KM}
          max={RADIUS_MAX_KM}
          step={1}
          value={shown}
          aria-valuetext={t('radius', { km: shown })}
          onChange={(e) => setDraft(Number(e.target.value))}
          onPointerUp={commit}
          onKeyUp={commit}
          onBlur={commit}
        />
        <span aria-hidden="true" className="text-content-muted text-xs tabular-nums">
          {RADIUS_MAX_KM}
        </span>
      </div>
    </div>
  );
}
