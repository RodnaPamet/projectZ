import { env } from '@/env';
import type { ChromeModules } from '@/components/layout/nav-items';

/**
 * Which product modules are switched on (#362; roadmap #379, phase 2).
 *
 * The player chrome has a place for each module from day one, and hides it
 * until the module ships: the Игри tab waits for open play (#376), the
 * messages icon for messaging (#375). Each is switched on by its environment
 * variable, `MODULE_OPEN_PLAY=1` or `MODULE_MESSAGING=1`, with no code change.
 * Both default off (`src/env.ts`).
 *
 * Server-side only. The layouts read it and hand the client plain booleans, so
 * no `NEXT_PUBLIC_` copy is baked into the bundle and a flag flips on the next
 * request after a restart, not on the next build.
 *
 * Hiding is the whole effect. A module's routes and APIs answer for themselves
 * whatever this says.
 */
export function readModules(): ChromeModules {
  return {
    openPlay: env.MODULE_OPEN_PLAY === '1',
    messaging: env.MODULE_MESSAGING === '1',
  };
}
