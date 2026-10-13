import { type NextRequest } from 'next/server';

import { removeCoachCertificate, saveCoachCertificate } from '@/app-layer/usecases/coach-profile';
import { asUser } from '@/app/api/v1/_lib/bind';
import { fileFromMultipart, readCappedBody } from '@/app/api/v1/_lib/capped-body';
import { toMyCoachProfile } from '@/app/api/v1/_lib/coach-dto';
import { contextFromRequest } from '@/app/api/v1/_lib/context';
import { defineV1Route } from '@/app/api/v1/_lib/define-route';
import { ok } from '@/app/api/v1/_lib/envelope';
import { CERTIFICATE_MAX_BYTES, CertificateRefusedError } from '@/lib/coaches/certificate';
import { UnauthorizedError } from '@/lib/errors/types';
import { getRequestId } from '@/lib/observability/context';
import { MEDIA_UPLOAD_LIMIT } from '@/lib/security/rate-limit';

/**
 * PUT    /api/v1/me/coach-profile/certificate   upload the certificate
 * DELETE /api/v1/me/coach-profile/certificate   remove it
 *
 * The one document a coach uploads for the owner's approval (#545; owner
 * decisions 13 and 17). `multipart/form-data` with the file under `file`: a
 * PDF, or a JPEG, PNG or WebP image, 5 MB at most. It is accepted by what its
 * first bytes say it is, never by its name or the type the client claimed;
 * anything else is 400 `CERTIFICATE_REFUSED` with `details.reason`
 * (`EMPTY`, `TOO_LARGE`, `NOT_A_CERTIFICATE`).
 *
 * A new upload replaces the one before it. The file is stored sealed, in the
 * database, and THERE IS NO ROUTE THAT GIVES IT BACK TO A COACH OR A CLUB:
 * the answer here is the profile, with the certificate's name, type, size and
 * upload time. Only a platform admin with `COACH_APPROVE` opens it.
 *
 * Allowed until the profile is sent, and again after a decline; 409
 * `COACH_PROFILE_LOCKED` while it is waiting, and once approved (the approval
 * was given on that document).
 *
 * The body is read through a cap, so an oversized upload is refused without
 * being buffered. Its own rate limit, apart from the mutation budget.
 */

/** The file plus the multipart framing around it. */
const MAX_BODY_BYTES = CERTIFICATE_MAX_BYTES + 64 * 1024;

async function putHandler(req: NextRequest) {
  // 401 before the body is read.
  const ctx = await contextFromRequest(req, { slug: null, requestId: getRequestId() });
  if (!ctx.userId) throw new UnauthorizedError('Authentication required');
  const userId = ctx.userId;

  const body = await readCappedBody(
    req,
    MAX_BODY_BYTES,
    () => new CertificateRefusedError('TOO_LARGE'),
  );
  const file = await fileFromMultipart(body, req.headers.get('content-type') ?? '');
  if (!file) throw new CertificateRefusedError('NOT_A_CERTIFICATE');

  const saved = await asUser(ctx, (db) => saveCoachCertificate(db, userId, file.bytes, file.name));
  return ok(toMyCoachProfile(saved));
}

async function deleteHandler(req: NextRequest) {
  const ctx = await contextFromRequest(req, { slug: null, requestId: getRequestId() });
  if (!ctx.userId) throw new UnauthorizedError('Authentication required');
  const userId = ctx.userId;
  return ok(toMyCoachProfile(await asUser(ctx, (db) => removeCoachCertificate(db, userId))));
}

export const PUT = defineV1Route(putHandler, {
  rateLimit: { config: MEDIA_UPLOAD_LIMIT, scope: 'coach-certificate' },
});
export const DELETE = defineV1Route(deleteHandler);
