'use server';

import { revalidatePath } from 'next/cache';

import { pricingRuleWriteSchema } from '@/app-layer/schemas/pricing';
import {
  createPricingRule,
  deletePricingRule,
  updatePricingRule,
} from '@/app-layer/usecases/pricing-rules';
import { requireTenantAction } from '@/lib/auth/page-context';
import { runInTenantContext } from '@/lib/db/rls-middleware';

/**
 * Pricing rule mutations.
 *
 * Every one calls `requireTenantAction` first — see the courts actions for why
 * that is not optional, and `server-actions-authorise` for what enforces it.
 *
 * `admin.pricing_manage`, not `courts.manage`: the two are separate permissions
 * in `ROLE_PERMISSIONS` because changing what a club charges is a different
 * decision from adding a court, and a MANAGER may reasonably hold one without
 * the other.
 */

type ActionResult = { ok: true } | { ok: false; error: string };

/** A checkbox group arrives as repeated entries, or not at all. */
function days(form: FormData): number[] | undefined {
  const raw = form.getAll('dayOfWeek').filter((v): v is string => typeof v === 'string');
  if (raw.length === 0) return undefined;
  return raw.map(Number).filter((n) => Number.isInteger(n));
}

function clock(form: FormData, key: string): string | undefined {
  const v = form.get(key);
  return typeof v === 'string' && v.trim() !== '' ? v : undefined;
}

function parse(form: FormData) {
  const from = clock(form, 'from');
  const to = clock(form, 'to');
  const mode = form.get('mode');
  // `Number('')` is 0 and `Number(null)` is 0. An absent amount therefore
  // stored `fixedPriceCents: 0` — a rule making the court free, sitting in the
  // list looking ordinary — or a x0 multiplier, which does the same.
  const rawAmount = form.get('amount');
  const amount =
    typeof rawAmount === 'string' && rawAmount.trim() !== '' ? Number(rawAmount) : Number.NaN;

  return pricingRuleWriteSchema.safeParse({
    resourceId: form.get('resourceId'),
    name: form.get('name'),
    priority: Number(form.get('priority')),
    conditions: {
      ...(days(form) ? { dayOfWeek: days(form) } : {}),
      // Both or neither: a half-specified window is the inverted-range case the
      // schema refuses, and refusing it there gives a better message than
      // silently dropping it here.
      ...(from && to ? { timeRange: { from, to } } : {}),
    },
    // `> 0`, not merely finite: a zero multiplier prices every matching
    // booking at nothing, and the schema's `.min(0)` permits it.
    multiplier: mode === 'multiplier' && Number.isFinite(amount) && amount > 0 ? amount : null,
    // The form takes euros for a fixed price because that is what a club
    // thinks in; cents is what the column stores. Rounded, not truncated —
    // 18.99 must not become 1898.
    // Zero IS legitimate here (a free members' hour), so it is allowed — but
    // only when actually typed, which the NaN above distinguishes from an
    // empty field.
    fixedPriceCents:
      mode === 'fixed' && Number.isFinite(amount) && amount >= 0 ? Math.round(amount * 100) : null,
  });
}

export async function createPricingRuleAction(
  slug: string,
  _prev: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  const ctx = await requireTenantAction(slug, 'admin.pricing_manage');

  const parsed = parse(form);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? 'invalid' };

  await runInTenantContext(ctx.tenantId, (db) =>
    createPricingRule(db, ctx.tenantId, ctx.userId, parsed.data),
  );

  revalidatePath(`/t/${slug}/admin/pricing`);
  return { ok: true };
}

export async function updatePricingRuleAction(
  slug: string,
  ruleId: string,
  _prev: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  const ctx = await requireTenantAction(slug, 'admin.pricing_manage');

  const parsed = parse(form);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? 'invalid' };

  await runInTenantContext(ctx.tenantId, (db) =>
    updatePricingRule(db, ctx.tenantId, ctx.userId, ruleId, parsed.data),
  );

  revalidatePath(`/t/${slug}/admin/pricing`);
  return { ok: true };
}

export async function deletePricingRuleAction(slug: string, ruleId: string): Promise<ActionResult> {
  const ctx = await requireTenantAction(slug, 'admin.pricing_manage');

  await runInTenantContext(ctx.tenantId, (db) =>
    deletePricingRule(db, ctx.tenantId, ctx.userId, ruleId),
  );

  revalidatePath(`/t/${slug}/admin/pricing`);
  return { ok: true };
}
