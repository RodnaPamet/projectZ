import { type NextRequest, NextResponse } from 'next/server';
import { PlatformCapability } from '@prisma/client';

import { openCoachCertificate } from '@/app-layer/usecases/coach-approval';
import { asPlatformAdmin } from '@/app/api/v1/_lib/bind';
import { contextFromRequest } from '@/app/api/v1/_lib/context';
import { defineV1Route } from '@/app/api/v1/_lib/define-route';
import { readPlatformReason } from '@/app/api/v1/_lib/platform-reason';
import { API_VERSION, API_VERSION_HEADER } from '@/lib/api-version';
import { CERTIFICATE_TYPES } from '@/lib/coaches/certificate';
import { getRequestId } from '@/lib/observability/context';

/**
 * GET /api/v1/platform/coaches/{userId}/certificate?reason=…
 *
 * The certificate a coach uploaded, opened: THE ONLY WAY ANYBODY BUT THE
 * COACH READS IT (#545; owner decision 17). Not a club, not a player, not the
 * coach's own routes.
 *
 * `COACH_APPROVE` and a fresh second-factor step-up. `reason` is required,
 * and every opening writes an audit row, `PLATFORM_COACH_CERTIFICATE_OPEN`,
 * naming the admin and the coach: who looked at whose document is on record.
 *
 * The answer is the file itself, always as a download
 * (`Content-Disposition: attachment`), never rendered by this origin:
 * `nosniff`, a sandboxing CSP, and `no-store`, so no cache keeps a copy. The
 * type is the one the file's own bytes gave at upload.
 *
 * 404 `COACH_APPLICATION_NOT_FOUND` when there is no profile, a draft, or no
 * certificate (a removed coach's is deleted).
 */
async function handler(req: NextRequest, { params }: { params: Promise<{ userId: string }> }) {
  const { userId } = await params;
  const ctx = await contextFromRequest(req, { requestId: getRequestId(), platformRoute: true });
  if (!ctx.userId) {
    return NextResponse.json(
      {
        error: {
          code: 'UNAUTHORIZED',
          message: 'Authentication required.',
          requestId: getRequestId(),
        },
      },
      { status: 401 },
    );
  }
  const stated = readPlatformReason(req.nextUrl.searchParams);
  if (!stated.ok) return stated.response;

  const file = await asPlatformAdmin(
    ctx,
    {
      capability: PlatformCapability.COACH_APPROVE,
      action: 'PLATFORM_COACH_CERTIFICATE_OPEN',
      reason: stated.reason,
      entity: 'CoachCertificate',
      entityId: userId,
      subjectTenantId: null,
    },
    (db) => openCoachCertificate(db, userId),
  );

  // The stored name may be Cyrillic: a plain ASCII fallback, and the real
  // name percent-encoded beside it (RFC 6266).
  const fallback = `certificate.${CERTIFICATE_TYPES[file.mimeType]}`;
  return new NextResponse(new Uint8Array(file.bytes), {
    status: 200,
    headers: {
      'content-type': file.mimeType,
      'content-length': String(file.bytes.byteLength),
      'content-disposition': `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(file.fileName)}`,
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "sandbox; default-src 'none'",
      [API_VERSION_HEADER]: API_VERSION,
    },
  });
}

export const GET = defineV1Route(handler);
