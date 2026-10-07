/**
 * The refusals of the second factor (#262).
 *
 * Plain `Error` subclasses, mapped to status and code BY NAME in
 * src/app/api/v1/_lib/errors.ts like every other domain error. Kept free of
 * imports so the binding, the use cases and the jsdom unit tests can all load
 * them without pulling in Prisma or Redis.
 *
 * The messages are written for whoever reads the log; each mapping carries a
 * `clientMessage` for whoever was refused.
 */

/** A cross-club write, asked for by a session that has not stepped up recently enough. */
export class PlatformStepUpRequiredError extends Error {
  constructor() {
    super(
      'This platform action needs a fresh second-factor step-up on this session. ' +
        'POST /api/v1/me/mfa/step-up with a current authenticator code (or a recovery ' +
        'code), then retry. A step-up lasts MFA_STEP_UP_WINDOW_SECONDS and belongs to the ' +
        'session that made it.',
    );
    this.name = 'PlatformStepUpRequiredError';
  }
}

/** A step-up, or a write that needs one, from an account with no second factor enrolled. */
export class MfaEnrolmentRequiredError extends Error {
  constructor() {
    super(
      'This account has no second factor enrolled, so it cannot step up, and every ' +
        'cross-club write needs a step-up. Enrol at /platform/security (POST ' +
        '/api/v1/me/mfa/enrolment, then /confirm).',
    );
    this.name = 'MfaEnrolmentRequiredError';
  }
}

/** Enrolment is for holders of a live platform grant (#262 scope). */
export class MfaNotEligibleError extends Error {
  constructor() {
    super(
      'Second-factor enrolment is open to holders of a live platform grant. This account ' +
        'holds none — whether club accounts must also enrol is an open product question.',
    );
    this.name = 'MfaNotEligibleError';
  }
}

export class MfaAlreadyEnrolledError extends Error {
  constructor() {
    super(
      'A second factor is already enrolled. Re-enrolling (a new phone) is an operator ' +
        'reset — docs/platform-admin-runbook.md — so a stolen session cannot swap the ' +
        "owner's authenticator for its own.",
    );
    this.name = 'MfaAlreadyEnrolledError';
  }
}

export class MfaEnrolmentNotStartedError extends Error {
  constructor() {
    super('There is no pending enrolment to confirm. Start one first.');
    this.name = 'MfaEnrolmentNotStartedError';
  }
}

/** The code did not verify: wrong, expired, already used, or a spent recovery code. */
export class MfaCodeRejectedError extends Error {
  constructor() {
    super('The second-factor code was not accepted.');
    this.name = 'MfaCodeRejectedError';
  }
}

/**
 * Enrolment from a session that is not freshly signed in.
 *
 * The first enrolment is trust-on-first-use: whoever enrols first owns the
 * second factor. Requiring a sign-in from the last few minutes means a cookie
 * stolen days ago cannot enrol the thief's phone on an admin who had not yet
 * got round to it — they would need the Google or Facebook account as well.
 */
export class MfaReauthRequiredError extends Error {
  constructor() {
    super(
      'Enrolling a second factor needs a fresh sign-in. Sign out, sign in again, and ' +
        'enrol within MFA_ENROL_FRESH_SIGN_IN_SECONDS.',
    );
    this.name = 'MfaReauthRequiredError';
  }
}
