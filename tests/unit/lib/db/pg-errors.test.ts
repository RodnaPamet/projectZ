import {
  accountKindViolation,
  isCheckViolation,
  isExclusionViolation,
  isSerializationFailure,
  isUniqueViolation,
  pgErrorCode,
} from '@/lib/db/pg-errors';

/**
 * The SQLSTATE discriminators.
 *
 * These decide whether a failure is a routine conflict to be handled or a real
 * fault to be raised, and both callers of `isSerializationFailure` SWALLOW the
 * error when it returns true. A discriminator that says true too readily turns
 * every failure into a silent skip — the sweep would report success having
 * done nothing, which is the worst possible shape for a job that moves money.
 */
describe('pg error discrimination', () => {
  // Prisma re-wraps the driver error, and the depth varies with how the
  // adapter classified it. These shapes are the ones observed in practice.
  const wrapped = (code: string) => ({
    name: 'PrismaClientKnownRequestError',
    code: 'P2010',
    meta: { driverAdapterError: { cause: { code } } },
  });

  it('finds the SQLSTATE however deep Prisma buried it', () => {
    expect(pgErrorCode(wrapped('40001'))).toBe('40001');
    expect(pgErrorCode({ cause: { cause: { originalCode: '23505' } } })).toBe('23505');
  });

  it('tells a serialization failure from every other conflict', () => {
    expect(isSerializationFailure(wrapped('40001'))).toBe(true);

    // The ones that must NOT be swallowed as "retry later".
    expect(isSerializationFailure(wrapped('23505'))).toBe(false);
    expect(isSerializationFailure(wrapped('23P01'))).toBe(false);
    expect(isSerializationFailure(wrapped('23514'))).toBe(false);
    // A deadlock is 40P01, one character from 40001 and a different decision.
    expect(isSerializationFailure(wrapped('40P01'))).toBe(false);
  });

  it('returns false rather than throwing on things that are not pg errors', () => {
    // A null return from `pgErrorCode` must not read as a match. An
    // `undefined === undefined` bug here would classify a TypeError — a real
    // crash — as a retryable conflict and swallow it.
    for (const notAnError of [null, undefined, 'boom', 42, new TypeError('x'), {}]) {
      expect(isSerializationFailure(notAnError)).toBe(false);
      expect(isUniqueViolation(notAnError)).toBe(false);
      expect(isExclusionViolation(notAnError)).toBe(false);
      expect(isCheckViolation(notAnError)).toBe(false);
    }
  });
});

describe('accountKindViolation — the p37 trigger’s refusal, told apart from every other CHECK', () => {
  // The shape measured from Prisma 7's adapter: P2039, the SQLSTATE and the
  // message in `driverAdapterError.cause`, and no constraint name anywhere.
  const refused = (message: string, code = '23514') => ({
    name: 'PrismaClientKnownRequestError',
    code: 'P2039',
    meta: {
      modelName: 'TenantMembership',
      driverAdapterError: { cause: { originalCode: code, originalMessage: message, code } },
    },
  });

  it.each([
    ['player_roles', 'account_kind_player_roles: account c1 is a PLAYER account, which …'],
    ['coach_roles', 'account_kind_coach_roles: account c1 is a COACH account, which …'],
    ['club_roles', 'account_kind_club_roles: account c1 is a CLUB account, which …'],
    [
      'one_club',
      'account_kind_one_club: account c1 is a CLUB account, which belongs to one club …',
    ],
  ])('names the %s rule', (rule, message) => {
    expect(accountKindViolation(refused(message))).toBe(rule);
  });

  it('finds the rule on a plain Error too, where message is not enumerable', () => {
    const err = Object.assign(new Error('account_kind_one_club: account c1 …'), { code: '23514' });
    expect(accountKindViolation(err)).toBe('one_club');
  });

  it('is null for every OTHER check violation — review_rating_range, say', () => {
    expect(
      accountKindViolation(refused('new row violates check constraint "review_rating_range"')),
    ).toBeNull();
  });

  it('is null when the SQLSTATE is not a check violation, whatever the message says', () => {
    // A message is not a code: a unique violation that happened to mention the
    // rule must not be read as the trigger refusing.
    expect(accountKindViolation(refused('account_kind_one_club: …', '23505'))).toBeNull();
  });

  it('is null, not a throw, for things that are not errors', () => {
    for (const notAnError of [null, undefined, 'account_kind_one_club', 42, {}]) {
      expect(accountKindViolation(notAnError)).toBeNull();
    }
  });
});
