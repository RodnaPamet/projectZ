import { defineV1Route } from '@/app/api/v1/_lib/define-route';
import { ok } from '@/app/api/v1/_lib/envelope';
import { readModules } from '@/lib/modules';

/**
 * GET /api/v1/config — which product modules are switched on (#621), for the
 * native app.
 *
 * The web hides a module that is off (`src/lib/modules.ts`), but hiding is
 * the whole effect: the module's routes answer either way. A native client
 * cannot read the switches, so without this it would show coaches, results
 * and tournaments on production, where only messaging and open play are on.
 * The app reads it at launch and when it comes back to the foreground, and
 * hides each module exactly as the web chrome does.
 *
 * Public: a signed-out visitor sees module content too (a venue's coaches).
 * The switches change only on a restart, but the default `private, no-store`
 * stays: a cached answer would keep a module shown, or hidden, after the
 * switch, and the call costs nothing.
 */
async function handler() {
  return ok({ modules: readModules() });
}

export const GET = defineV1Route(handler);
