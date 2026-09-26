'use server';

import { revalidatePath } from 'next/cache';

import { adjustPlayerCredit, setPlayerTags } from '@/app-layer/usecases/players';
import { requireTenantAction } from '@/lib/auth/page-context';
import { runInTenantContext } from '@/lib/db/rls-middleware';

/**
 * Player mutations.
 *
 * ═══ TWO PERMISSIONS, NOT ONE ═══
 *
 * Tags are `players.view` — they are club-side labels, and STAFF and COACH
 * already hold that. Credit is `players.credit_adjust`, which in
 * `ROLE_PERMISSIONS` only OWNER and MANAGER have: moving money is a different
 * decision from labelling somebody "beginner".
 *
 * Reusing one permission for both would silently give every coach the wallet.
 */

type ActionResult = { ok: true } | { ok: false; error: string };

export async function setPlayerTagsAction(
  slug: string,
  playerUserId: string,
  _prev: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  const ctx = await requireTenantAction(slug, 'players.view');

  const raw = form.get('tags');
  const tags = typeof raw === 'string' ? raw.split(',') : [];

  await runInTenantContext(ctx.tenantId, (db) =>
    setPlayerTags(db, ctx.tenantId, ctx.userId, playerUserId, tags),
  );

  revalidatePath(`/t/${slug}/admin/players`);
  return { ok: true };
}

export async function adjustCreditAction(
  slug: string,
  playerUserId: string,
  _prev: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  const ctx = await requireTenantAction(slug, 'players.credit_adjust');

  // Euros in the form, cents in the column. Rounded, not truncated: 4.99 must
  // not become 498.
  const amount = Number(form.get('amount'));
  const sign = form.get('direction') === 'debit' ? -1 : 1;
  const note = String(form.get('note') ?? '').trim();

  // `>= 1 cent`, not `> 0`: a sub-cent amount rounds to a zero delta, and
  // `appendEntry` refuses that with a thrown Error rather than a result — so
  // 0.004 produced an error boundary instead of the message this form renders.
  if (!Number.isFinite(amount) || Math.round(amount * 100) < 1) {
    return { ok: false, error: 'AMOUNT_INVALID' };
  }
  if (note.length < 8) {
    // The ledger row records the money and has nowhere to put a reason. The
    // audit row is the only record of WHY, and "adj" answers nothing six
    // months later.
    return { ok: false, error: 'NOTE_REQUIRED' };
  }

  try {
    await runInTenantContext(
      ctx.tenantId,
      (db) =>
        adjustPlayerCredit(db, ctx.tenantId, ctx.userId, {
          playerUserId,
          deltaCents: Math.round(amount * 100) * sign,
          note,
        }),
      undefined,
      // ═══ NOT OPTIONAL ═══
      //
      // `appendEntry` reads the running balance and writes the next one, and
      // refuses to run at anything weaker than SERIALIZABLE — under READ
      // COMMITTED two concurrent appends read the same balance and write the
      // same total, and the ledger stops agreeing with itself without raising.
      //
      // Isolation can only be set on the OUTERMOST BEGIN, which is this one.
      // Asking for it inside would be silently dropped to a SAVEPOINT.
      { isolationLevel: 'Serializable' },
    );
  } catch (err) {
    // The ledger refuses to go negative — "a negative balance means we let
    // someone spend credit they do not have". The form caps the debit at the
    // current balance, so reaching this means the balance moved underneath the
    // person typing, which is worth saying plainly rather than as a 500.
    const message = err instanceof Error ? err.message : '';
    if (/insufficient credit/i.test(message)) return { ok: false, error: 'INSUFFICIENT_CREDIT' };
    if (/capped at/i.test(message)) return { ok: false, error: 'TOO_LARGE' };
    // ═══ 40001 IS EXPECTED HERE, NOT EXCEPTIONAL ═══
    //
    // The ledger runs SERIALIZABLE precisely so concurrent appends abort
    // rather than both writing the same balance. Two managers adjusting one
    // player — or one adjusting while that player checks out — is an ordinary
    // collision, and rethrowing gave the admin an error boundary and no idea
    // whether the money had moved.
    //
    // Surfaced rather than retried: a retry would re-read the balance, and the
    // person typed an amount against the balance they were shown. Asking them
    // to look again is the honest answer.
    const code = (err as { code?: string })?.code;
    if (code === 'P2034' || /40001|could not serialize/i.test(message)) {
      return { ok: false, error: 'CONFLICT' };
    }
    throw err;
  }

  revalidatePath(`/t/${slug}/admin/players`);
  return { ok: true };
}
