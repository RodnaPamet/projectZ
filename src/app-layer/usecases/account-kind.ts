import type { ChoosableAccountKind } from '@/app-layer/schemas/booking-players';
import { accountKindViolation } from '@/lib/db/pg-errors';
import { runAsUserOnly } from '@/lib/db/rls-middleware';

/**
 * First sign-in: "Играч или треньор?" (#360, Q13).
 *
 * A new account starts with `accountKind` NULL (auth.ts) and is asked before
 * anything else. Clubs are created by the owner, so CLUB is never a choice.
 *
 * ═══ ONCE ═══
 *
 * One account, one kind (#263): the choice is made once and cannot be switched
 * here. The write is a compare-and-set, `UPDATE … WHERE accountKind IS NULL`,
 * so two tabs racing their first choice cannot both win and a second request
 * cannot overwrite the first: it updates zero rows and is told the kind is
 * already set. `PATCH /me` refuses `accountKind` outright (`.strict()`), so
 * there is no second door.
 *
 * ═══ AND IT MUST FIT WHAT THE ACCOUNT HOLDS ═══
 *
 * Most undecided accounts are brand new and hold nothing. Some are older ones
 * the P37 migration left undecided, holding a COACH role; choosing PLAYER for
 * one of those is refused by the database (`account_kind_user_trg`), and the
 * refusal is answered as "this account cannot be that kind" rather than a 500.
 *
 * ═══ WHY runAsUserOnly ═══
 *
 * `app_user` is global (no RLS) and the WHERE is the session's own id, so this
 * can only ever touch the caller's row. No club is involved.
 */

export class AccountKindAlreadySetError extends Error {
  constructor() {
    super('This account has already chosen whether it is a player or a coach; that is permanent.');
    this.name = 'AccountKindAlreadySetError';
  }
}

export class AccountKindNotAllowedError extends Error {
  constructor(kind: ChoosableAccountKind) {
    super(
      `This account cannot become a ${kind} account: it already holds a role that belongs to ` +
        'another kind of account (#263).',
    );
    this.name = 'AccountKindNotAllowedError';
  }
}

/**
 * The caller's kind, for a page deciding whether to ask first (the chooser,
 * the invite page). Null is "not chosen"; undefined is "no such account".
 */
export async function readMyAccountKind(userId: string) {
  const row = await runAsUserOnly(userId, (db) =>
    db.user.findUnique({ where: { id: userId }, select: { accountKind: true } }),
  );
  return row ? row.accountKind : undefined;
}

/** False for a session whose account row is gone: the route answers 401. */
export async function chooseAccountKind(
  userId: string,
  kind: ChoosableAccountKind,
): Promise<boolean> {
  return runAsUserOnly(userId, async (db) => {
    let count: number;
    try {
      ({ count } = await db.user.updateMany({
        where: { id: userId, accountKind: null },
        data: { accountKind: kind },
      }));
    } catch (err) {
      if (accountKindViolation(err)) throw new AccountKindNotAllowedError(kind);
      throw err;
    }
    if (count === 1) return true;

    const exists = await db.user.findUnique({ where: { id: userId }, select: { id: true } });
    if (!exists) return false;
    throw new AccountKindAlreadySetError();
  });
}
