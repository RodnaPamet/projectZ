'use client';

import { useCallback, useEffect, useState } from 'react';

/**
 * Where the browser says the person is, for «Близо до мен» (#697).
 *
 *   idle      not asked (the mode is off)
 *   locating  asked; the browser (or the person) has not answered yet
 *   found     a fix, in `lat` / `lng`
 *   denied    the person, or the browser's settings, said no
 *   failed    no fix: no geolocation at all, a timeout, no signal
 *
 * Asked once each time `active` turns on, and again on `retry`. The fix goes
 * only to our own `GET /venues/near`, rounded to about 100 m there.
 */
export type Here =
  | { status: 'idle' | 'locating' | 'denied' | 'failed' }
  | { status: 'found'; lat: number; lng: number };

/** A fix up to five minutes old will do: the person has not gone far. */
const OPTIONS: PositionOptions = {
  enableHighAccuracy: false,
  maximumAge: 300_000,
  timeout: 15_000,
};

function geolocation(): Geolocation | undefined {
  return typeof navigator !== 'undefined' ? navigator.geolocation : undefined;
}

/** What a fresh ask starts as: locating, or failed at once with no geolocation at all. */
function asked(active: boolean): Here {
  if (!active) return { status: 'idle' };
  return geolocation() ? { status: 'locating' } : { status: 'failed' };
}

export function useHere(active: boolean): { here: Here; retry: () => void } {
  const [here, setHere] = useState<Here>(() => asked(active));
  const [attempt, setAttempt] = useState(0);
  const [seen, setSeen] = useState({ active, attempt });

  // Turned off: forget the fix; turned on or retried: locating, in the same
  // render (React's "adjust state while rendering", no effect frame between).
  if (seen.active !== active || seen.attempt !== attempt) {
    setSeen({ active, attempt });
    setHere(asked(active));
  }

  useEffect(() => {
    const geo = geolocation();
    if (!active || !geo) return;
    let live = true;
    geo.getCurrentPosition(
      (p) => {
        if (live) setHere({ status: 'found', lat: p.coords.latitude, lng: p.coords.longitude });
      },
      (e) => {
        // 1 is PERMISSION_DENIED; the constant is not on every engine's error.
        if (live) setHere({ status: e.code === 1 ? 'denied' : 'failed' });
      },
      OPTIONS,
    );
    return () => {
      live = false;
    };
  }, [active, attempt]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  return { here, retry };
}
