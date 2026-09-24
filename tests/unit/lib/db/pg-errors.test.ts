import {
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
