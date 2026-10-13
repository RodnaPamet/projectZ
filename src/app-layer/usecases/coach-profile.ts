import type { PrismaClient } from '@prisma/client';

import {
  inspectCertificate,
  sealCertificate,
  type CertificateMime,
} from '@/lib/coaches/certificate';
import {
  canChangeCertificate,
  canEditCoachText,
  coachSlugBase,
  coachSlugCandidate,
  missingForSubmission,
  readCoachProfileInput,
  type CoachProfileMissing,
  type CoachProfileState,
  type CoachSportInput,
} from '@/lib/coaches/profile';
import { sanitizePlainText } from '@/lib/security/sanitize';

/**
 * A COACH'S OWN PROFILE (#545, #377; owner decisions 13 and 17).
 *
 * A coach fills in a text, the sports and levels they teach, their
 * qualifications, and uploads one certificate; then sends it all to the
 * platform owner, who approves or declines (`coach-approval.ts`).
 *
 *   NONE ──save──▶ DRAFT ──submit──▶ SUBMITTED ──▶ APPROVED
 *                    ▲                  │    └────▶ DECLINED ──(edit, submit)──▶ SUBMITTED
 *                    └────withdraw──────┘
 *
 * ═══ WHO RUNS THIS ═══
 *
 * Every function takes a handle bound to the coach (`asUser`): the profile,
 * its sports and the certificate are owner-only in the database (P71), so a
 * handle bound to anyone else finds nothing to change. Nothing here can write
 * a decision: the database refuses APPROVED or DECLINED outside a platform
 * admin's transaction (P72), whatever this file does.
 *
 * ═══ WHAT IS LOCKED WHEN ═══
 *
 * While SUBMITTED nothing changes: what the owner reads is what was sent.
 * Once APPROVED the text and sports are the coach's to edit (they must stay
 * complete), and the certificate stays as approved. `src/lib/coaches/profile`
 * holds both rules, so the form applies them too.
 */

/** The account is not a coach's (or is gone): a profile is a coach's only. */
export class CoachAccountRequiredError extends Error {
  constructor() {
    super('This is for coach accounts.');
    this.name = 'CoachAccountRequiredError';
  }
}

/** The profile cannot be changed in the state it is in. */
export class CoachProfileLockedError extends Error {
  constructor(readonly state: CoachProfileState) {
    super(`The coach profile cannot be changed while it is ${state}.`);
    this.name = 'CoachProfileLockedError';
  }
}

/** Something a submitted or approved profile must have is missing. */
export class CoachProfileIncompleteError extends Error {
  constructor(readonly missing: CoachProfileMissing[]) {
    super(`The coach profile is missing: ${missing.join(', ')}.`);
    this.name = 'CoachProfileIncompleteError';
  }
}

/** Asked to take back a profile that is not waiting for a decision. */
export class CoachProfileNotSubmittedError extends Error {
  constructor() {
    super('The coach profile is not waiting for a decision.');
    this.name = 'CoachProfileNotSubmittedError';
  }
}

export interface CoachCertificateView {
  fileName: string;
  mimeType: CertificateMime;
  byteSize: number;
  uploadedAt: Date;
}

export interface MyCoachProfile {
  state: CoachProfileState;
  /** The address of the coach's page, once there is a profile. */
  slug: string | null;
  bio: string | null;
  qualifications: string | null;
  sports: CoachSportInput[];
  /** What was uploaded, never the document itself. */
  certificate: CoachCertificateView | null;
  submittedAt: Date | null;
  decidedAt: Date | null;
  /** The owner's note with the last decision. */
  decisionNote: string | null;
  /** What it still needs before it can be sent. */
  missing: CoachProfileMissing[];
  canEdit: { text: boolean; certificate: boolean };
}

async function requireCoach(db: PrismaClient, userId: string): Promise<{ name: string | null }> {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { accountKind: true, deletedAt: true, name: true },
  });
  if (!user || user.deletedAt || user.accountKind !== 'COACH') {
    throw new CoachAccountRequiredError();
  }
  return { name: user.name };
}

const CERT_SELECT = { fileName: true, mimeType: true, byteSize: true, uploadedAt: true } as const;

async function read(db: PrismaClient, userId: string): Promise<MyCoachProfile> {
  const [profile, certificate] = await Promise.all([
    db.coachProfile.findUnique({
      where: { userId },
      select: {
        slug: true,
        bio: true,
        qualifications: true,
        status: true,
        submittedAt: true,
        decidedAt: true,
        decisionNote: true,
        sports: {
          select: { sport: true, levelMin: true, levelMax: true },
          orderBy: { sport: 'asc' },
        },
      },
    }),
    db.coachCertificate.findUnique({ where: { userId }, select: CERT_SELECT }),
  ]);
  const state: CoachProfileState = profile?.status ?? 'NONE';
  const sports = profile?.sports ?? [];
  return {
    state,
    slug: profile?.slug ?? null,
    bio: profile?.bio ?? null,
    qualifications: profile?.qualifications ?? null,
    sports,
    certificate: certificate
      ? { ...certificate, mimeType: certificate.mimeType as CertificateMime }
      : null,
    submittedAt: profile?.submittedAt ?? null,
    decidedAt: profile?.decidedAt ?? null,
    decisionNote: profile?.decisionNote ?? null,
    missing: missingForSubmission({
      bio: profile?.bio ?? null,
      sports,
      hasCertificate: certificate !== null,
    }),
    canEdit: { text: canEditCoachText(state), certificate: canChangeCertificate(state) },
  };
}

/** The caller's profile as it stands. A coach with none yet gets `NONE`. */
export async function myCoachProfile(db: PrismaClient, userId: string): Promise<MyCoachProfile> {
  await requireCoach(db, userId);
  return read(db, userId);
}

/** How many addresses are tried before one is made unique by force. */
const SLUG_ATTEMPTS = 30;

/**
 * Make sure the coach has a profile row, and lock it for this transaction.
 *
 * The address comes from the account's name. Two coaches called Иван Петров
 * get `ivan-petrov` and `ivan-petrov-2`: the insert that loses to the unique
 * index does nothing (`ON CONFLICT DO NOTHING`, so the transaction is not
 * aborted) and the next candidate is tried. The coach cannot see the other
 * row, and does not need to.
 *
 * Returns the state the row is in, read under the lock.
 */
async function ensureLocked(
  db: PrismaClient,
  userId: string,
  name: string | null,
): Promise<CoachProfileState> {
  const locked = () =>
    db.$queryRaw<Array<{ status: CoachProfileState }>>`
      SELECT "status"::text AS "status" FROM "coach_profile" WHERE "userId" = ${userId} FOR UPDATE`;

  const existing = await locked();
  if (existing[0]) return existing[0].status;

  const base = coachSlugBase(name);
  for (let attempt = 1; attempt <= SLUG_ATTEMPTS + 1; attempt++) {
    const slug =
      attempt <= SLUG_ATTEMPTS
        ? coachSlugCandidate(base, attempt)
        : // Thirty coaches of one name: the account's own id ends the search.
          `${base}-${userId.slice(-8).toLowerCase()}`;
    await db.$executeRaw`
      INSERT INTO "coach_profile" ("userId", "slug", "updatedAt")
      VALUES (${userId}, ${slug}, now())
      ON CONFLICT DO NOTHING`;
    // Ours now, by this insert or by a request that raced it.
    const row = await locked();
    if (row[0]) return row[0].status;
  }
  throw new Error('coach profile: no address could be made for this account');
}

/**
 * Save the text and the sports. An empty profile is a valid draft; an
 * approved one must stay complete, because it is what players read.
 */
export async function saveCoachProfile(
  db: PrismaClient,
  userId: string,
  raw: { bio?: unknown; qualifications?: unknown; sports?: unknown },
): Promise<MyCoachProfile> {
  const user = await requireCoach(db, userId);
  const input = readCoachProfileInput({
    bio: typeof raw.bio === 'string' ? sanitizePlainText(raw.bio) : raw.bio,
    qualifications:
      typeof raw.qualifications === 'string'
        ? sanitizePlainText(raw.qualifications)
        : raw.qualifications,
    sports: raw.sports,
  });

  const state = await ensureLocked(db, userId, user.name);
  if (!canEditCoachText(state)) throw new CoachProfileLockedError(state);
  if (state === 'APPROVED') {
    const missing = missingForSubmission({ ...input, hasCertificate: true });
    if (missing.length > 0) throw new CoachProfileIncompleteError(missing);
  }

  await db.coachProfile.update({
    where: { userId },
    data: { bio: input.bio, qualifications: input.qualifications },
  });
  await db.coachProfileSport.deleteMany({ where: { userId } });
  if (input.sports.length > 0) {
    await db.coachProfileSport.createMany({
      data: input.sports.map((s) => ({ userId, ...s })),
    });
  }
  return read(db, userId);
}

/**
 * Keep the certificate the coach uploaded, replacing the one before it.
 *
 * `bytes` is the file as sent. It is accepted by what it is (a PDF or an
 * image, 5 MB at most), stored sealed, and never read back by this file.
 * Throws `CertificateRefusedError` for anything else.
 */
export async function saveCoachCertificate(
  db: PrismaClient,
  userId: string,
  bytes: Uint8Array,
  rawName: unknown,
  now: Date = new Date(),
): Promise<MyCoachProfile> {
  const user = await requireCoach(db, userId);
  // Before any row is touched: a refused file changes nothing.
  const described = inspectCertificate(bytes, rawName);

  const state = await ensureLocked(db, userId, user.name);
  if (!canChangeCertificate(state)) throw new CoachProfileLockedError(state);

  // A copy in its own ArrayBuffer, which is what the Bytes column is typed as.
  const row = { ...described, content: new Uint8Array(sealCertificate(bytes)), uploadedAt: now };
  await db.coachCertificate.upsert({
    where: { userId },
    create: { userId, ...row },
    update: row,
  });
  return read(db, userId);
}

/** Remove the uploaded certificate. With none there, nothing changes. */
export async function removeCoachCertificate(
  db: PrismaClient,
  userId: string,
): Promise<MyCoachProfile> {
  const user = await requireCoach(db, userId);
  const state = await ensureLocked(db, userId, user.name);
  if (!canChangeCertificate(state)) throw new CoachProfileLockedError(state);
  await db.coachCertificate.deleteMany({ where: { userId } });
  return read(db, userId);
}

/**
 * Send the profile to the platform owner. It needs a text, a sport and a
 * certificate; what is missing is named. The decision before this one, if
 * there was one, is cleared: this is a new application.
 *
 * Returns `submitted: false` when it was already waiting, so the caller does
 * not announce it twice.
 */
export async function submitCoachProfile(
  db: PrismaClient,
  userId: string,
  now: Date = new Date(),
): Promise<{ profile: MyCoachProfile; submitted: boolean }> {
  const user = await requireCoach(db, userId);
  const state = await ensureLocked(db, userId, user.name);
  if (state === 'SUBMITTED') return { profile: await read(db, userId), submitted: false };
  if (state === 'APPROVED') throw new CoachProfileLockedError(state);

  const before = await read(db, userId);
  if (before.missing.length > 0) throw new CoachProfileIncompleteError(before.missing);

  await db.coachProfile.update({
    where: { userId },
    data: {
      status: 'SUBMITTED',
      submittedAt: now,
      decidedAt: null,
      decidedByUserId: null,
      decisionNote: null,
    },
  });
  return { profile: await read(db, userId), submitted: true };
}

/** Take a waiting profile back to change it. It leaves the owner's queue. */
export async function withdrawCoachProfile(
  db: PrismaClient,
  userId: string,
): Promise<MyCoachProfile> {
  const user = await requireCoach(db, userId);
  const state = await ensureLocked(db, userId, user.name);
  if (state !== 'SUBMITTED') throw new CoachProfileNotSubmittedError();
  await db.coachProfile.update({
    where: { userId },
    data: { status: 'DRAFT', submittedAt: null },
  });
  return read(db, userId);
}
