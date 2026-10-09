import type { ResourceType, SportType } from '@prisma/client';

import { SPORTS } from './registry';
import { RESOURCE_KINDS, RESOURCE_TYPES, resourceNoun, type ResourceNoun } from './resource-kinds';

/**
 * WHICH SPORTS A RESOURCE MAY HOLD (P51), AND WHAT A NEW ONE IS (#472).
 *
 * A TRACK is EXCLUSIVE: karting is always on one, and nothing else is. The
 * other types are loose: a sport's resource may be stored as any of them, so
 * a court a spec onboarded as a FIELD, or a FIELD switched to tennis, keeps
 * its type. A NEW resource follows its sport (owner decision, 2026-10-09):
 * football, 5-a-side and handball are FIELDs ("игрище"), tennis, padel and
 * squash COURTs. Rows stored before that are not changed. The onboarding
 * spec, the courts screen's schema and its edits all decide the type here.
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
 * The type a new resource of `sport` gets when nobody says, as the courts
 * screen (which asks for none) and a spec that leaves it out do: the sport's
 * own, from the registry. A football or handball pitch is a FIELD, a tennis
 * court a COURT, a karting track a TRACK (#472).
 */
export function defaultResourceType(sport: SportType): ResourceType {
  return SPORTS[sport].resourceType;
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
