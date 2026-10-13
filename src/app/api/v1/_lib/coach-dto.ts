import type { MyCoachProfile } from '@/app-layer/usecases/coach-profile';
import type {
  CoachApplication,
  CoachApplicationItem,
  CoachDecisionResult,
} from '@/app-layer/usecases/coach-approval';
import { rfc3339 } from '@/app/api/v1/_lib/dto';

/** The shapes the coach routes answer with (#545): dates as RFC 3339, nothing else changed. */

const at = (d: Date | null) => (d ? rfc3339(d) : null);

const certificate = (
  c: { fileName: string; mimeType: string; byteSize: number; uploadedAt: Date } | null,
) =>
  c
    ? {
        fileName: c.fileName,
        mimeType: c.mimeType,
        byteSize: c.byteSize,
        uploadedAt: rfc3339(c.uploadedAt),
      }
    : null;

export function toMyCoachProfile(p: MyCoachProfile) {
  return {
    state: p.state,
    slug: p.slug,
    bio: p.bio,
    qualifications: p.qualifications,
    sports: p.sports.map((s) => ({ sport: s.sport, levelMin: s.levelMin, levelMax: s.levelMax })),
    certificate: certificate(p.certificate),
    submittedAt: at(p.submittedAt),
    decidedAt: at(p.decidedAt),
    decisionNote: p.decisionNote,
    missing: p.missing,
    canEdit: p.canEdit,
  };
}

export function toCoachApplicationItem(i: CoachApplicationItem) {
  return {
    userId: i.userId,
    name: i.name,
    slug: i.slug,
    status: i.status,
    submittedAt: at(i.submittedAt),
    decidedAt: at(i.decidedAt),
    sports: i.sports.map((s) => ({ sport: s.sport, levelMin: s.levelMin, levelMax: s.levelMax })),
    hasCertificate: i.hasCertificate,
  };
}

export function toCoachApplication(a: CoachApplication) {
  return {
    ...toCoachApplicationItem(a),
    bio: a.bio,
    qualifications: a.qualifications,
    decisionNote: a.decisionNote,
    decidedByUserId: a.decidedByUserId,
    certificate: certificate(a.certificate),
    upcomingLessons: a.upcomingLessons,
  };
}

export function toCoachDecision(d: CoachDecisionResult) {
  return { userId: d.userId, status: d.status, decidedAt: rfc3339(d.decidedAt) };
}
