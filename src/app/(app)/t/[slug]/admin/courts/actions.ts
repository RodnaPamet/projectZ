'use server';

import { revalidatePath } from 'next/cache';

import { courtCreateSchema, courtUpdateSchema } from '@/app-layer/schemas/court';
import { archiveCourt, createCourt, updateCourt } from '@/app-layer/usecases/courts';
import { requireTenantAction } from '@/lib/auth/page-context';
import { runInTenantContext } from '@/lib/db/rls-middleware';

/**
 * The first Server Actions in this repo.
 *
 * ═══ WHY ACTIONS RATHER THAN /api/v1 ROUTES ═══
 *
 * Every v1 route must appear in `openapi/playerz-v1.json` — `openapi-coverage`
 * fails the build otherwise — and the spec is what the iOS client is generated
 * from. Court administration is a web-only surface for club staff; putting it
 * on the versioned API would document it for a native client that should never
 * call it, and then need the same exclusion treatment the platform routes got.
 *
 * An action has no URL of its own and no spec entry. The cost is that it also
 * has no middleware rule, which is the next section.
 *
 * ═══ EVERY ACTION AUTHORISES ITSELF, FIRST ═══
 *
 * A Server Action is a POST endpoint reachable by anyone who can construct the
 * request; the action id is in the page payload. It does not re-run the page,
 * so the page's `courts.manage` check protects the screen and not this.
 *
 * Middleware gates membership, because the action posts to the page's own
 * `/t/[slug]/...` path — but not the permission, since every rule in
 * `route-permissions.ts` is anchored at `^/api/`. A COACH is a member and would
 * reach these.
 *
 * `requireTenantAction` therefore runs before anything reads the form, and it
 * throws rather than returning a value a caller could forget to check.
 * `tests/guardrails/server-actions-authorise.test.ts` fails the build if an
 * exported action in this tree omits it.
 *
 * ═══ VALIDATION IS NOT THE BROWSER'S JOB ═══
 *
 * The form marks fields required and types them `number`. None of that reaches
 * the server. Every action re-parses with the Zod schema, which is also where
 * the booking-window rules live — a court with min 90 and max 60 offers no
 * bookable span and renders as "no availability", which reads as a calendar bug.
 */

type ActionResult = { ok: true } | { ok: false; error: string };

/** Numbers arrive from a FormData as strings; `Number('')` is 0, which is a price. */
function int(form: FormData, key: string): number | undefined {
  const raw = form.get(key);
  if (typeof raw !== 'string' || raw.trim() === '') return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

export async function createCourtAction(
  slug: string,
  _prev: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  const ctx = await requireTenantAction(slug, 'courts.manage');

  const parsed = courtCreateSchema.safeParse({
    venueId: form.get('venueId'),
    name: form.get('name'),
    sport: form.get('sport'),
    surface: form.get('surface'),
    isIndoor: form.get('isIndoor') === 'on',
    capacity: int(form, 'capacity'),
    basePriceCents: int(form, 'basePriceCents'),
    minBookingMinutes: int(form, 'minBookingMinutes'),
    maxBookingMinutes: int(form, 'maxBookingMinutes'),
    slotStepMinutes: int(form, 'slotStepMinutes'),
  });
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? 'invalid' };

  await runInTenantContext(ctx.tenantId, (db) =>
    createCourt(db, ctx.tenantId, ctx.userId, parsed.data),
  );

  revalidatePath(`/t/${slug}/admin/courts`);
  return { ok: true };
}

export async function updateCourtAction(
  slug: string,
  courtId: string,
  _prev: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  const ctx = await requireTenantAction(slug, 'courts.manage');

  const parsed = courtUpdateSchema.safeParse({
    name: form.get('name'),
    sport: form.get('sport'),
    surface: form.get('surface'),
    isIndoor: form.get('isIndoor') === 'on',
    capacity: int(form, 'capacity'),
    basePriceCents: int(form, 'basePriceCents'),
    minBookingMinutes: int(form, 'minBookingMinutes'),
    maxBookingMinutes: int(form, 'maxBookingMinutes'),
    slotStepMinutes: int(form, 'slotStepMinutes'),
  });
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? 'invalid' };

  await runInTenantContext(ctx.tenantId, (db) =>
    updateCourt(db, ctx.tenantId, ctx.userId, courtId, parsed.data),
  );

  revalidatePath(`/t/${slug}/admin/courts`);
  return { ok: true };
}

export async function archiveCourtAction(
  slug: string,
  courtId: string,
  reopen: boolean,
): Promise<ActionResult> {
  const ctx = await requireTenantAction(slug, 'courts.manage');

  await runInTenantContext(ctx.tenantId, (db) =>
    archiveCourt(db, ctx.tenantId, ctx.userId, courtId, { reopen }),
  );

  revalidatePath(`/t/${slug}/admin/courts`);
  return { ok: true };
}
