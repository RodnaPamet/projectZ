import type { ResourceType, SportType } from '@prisma/client';

import { SPORTS } from './registry';
import { RESOURCE_KINDS, RESOURCE_TYPES, resourceNoun, type ResourceNoun } from './resource-kinds';

/**
 * WHICH SPORTS A RESOURCE MAY HOLD (P51).
 *
 * A TRACK is EXCLUSIVE: karting is always on one, and nothing else is. The
 * other types keep the old, loose rule — a court sport is a COURT unless the
 * club says otherwise (a 5-a-side pitch onboarded as a FIELD) — so no existing
 * club's spec or court changes meaning. The onboarding spec, the courts
 * screen's schema and its edits all decide the type here.
 *
 * What a resource is CALLED is `resource-kinds.ts`, which does not need the
 * sport registry; this module does.
 */

/** The resource types a court of `sport` may be stored as. */
export function allowedResourceTypes(sport: SportType): readonly ResourceType[] {
  const own = SPORTS[sport].resourceType;
  if (RESOURCE_KINDS[own].exclusive) return [own];
  return RESOURCE_TYPES.filter((t) => !RESOURCE_KINDS[t].exclusive);
}

/**
 * The type a new court of `sport` gets when nobody says: its exclusive type
 * (karting: TRACK), otherwise COURT — the default onboarding and the courts
 * screen have always used, so a 5-a-side pitch is a FIELD only when a spec
 * says so.
 */
export function defaultResourceType(sport: SportType): ResourceType {
  const own = SPORTS[sport].resourceType;
  return RESOURCE_KINDS[own].exclusive ? own : 'COURT';
}

/**
 * The type a court has after its sport is set to `sport`: unchanged while it
 * is still allowed (a FIELD stays a FIELD), else the sport's default. A court
 * switched to karting becomes a TRACK, and a track switched to squash a COURT.
 */
export function resourceTypeAfter(sport: SportType, current: ResourceType): ResourceType {
  return allowedResourceTypes(sport).includes(current) ? current : defaultResourceType(sport);
}

/**
 * The noun a court of `sport` will read as once saved: for the courts form,
 * before the court exists or while its sport is being changed.
 */
export function nounForSport(sport: SportType, current?: ResourceType): ResourceNoun {
  return resourceNoun(current ? resourceTypeAfter(sport, current) : defaultResourceType(sport));
}
