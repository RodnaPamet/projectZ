import type { ResourceType } from '@prisma/client';

/**
 * WHAT A BOOKABLE RESOURCE IS CALLED (P51).
 *
 * Booking, availability and pricing never look at a resource's type: a karting
 * TRACK is held, priced and refused exactly as a padel COURT is. What the type
 * changes is the COPY. A track is a "писта", and every sentence about one
 * agrees with a feminine noun ("Пистата ще се освободи", "Активна"). The UI
 * picks its wording from `resourceNoun(resourceType)`, never from the sport.
 *
 * Which sports may use which type is `resources.ts`, which needs the sport
 * registry; this module does not, so a client component that only names a
 * resource does not carry the registry in its bundle.
 *
 * ═══ EXHAUSTIVE BY TYPE ═══
 *
 * `RESOURCE_KINDS` is a `Record<ResourceType, …>`: a resource type added to the
 * schema without a row here is a compile error, and a new NOUN then fails
 * `tests/guardrails/sport-exhaustiveness.test.ts` until every noun-dependent
 * message has its wording. The noun is copy, so it is a closed set the
 * catalogue mirrors: the court wording is a key's plain path, the track
 * wording the same path with `track.` after the namespace the component binds,
 * and the wording for a list holding both with `mixed.`.
 */

/** The noun a resource takes in copy. Every type but TRACK has always read "корт". */
export type ResourceNoun = 'court' | 'track';

/** The noun of a LIST of resources: one noun, or both. Empty reads as courts. */
export type ResourceNouns = ResourceNoun | 'mixed';

interface ResourceKind {
  noun: ResourceNoun;
  /**
   * Only the sports the registry puts on this type may use it, and they may
   * use nothing else (`allowedResourceTypes` in resources.ts).
   */
  exclusive: boolean;
}

export const RESOURCE_KINDS: Record<ResourceType, ResourceKind> = {
  COURT: { noun: 'court', exclusive: false },
  FIELD: { noun: 'court', exclusive: false },
  TABLE: { noun: 'court', exclusive: false },
  BOARD_TABLE: { noun: 'court', exclusive: false },
  LOBBY: { noun: 'court', exclusive: false },
  ROUTE: { noun: 'court', exclusive: false },
  TRACK: { noun: 'track', exclusive: true },
};

/** Every resource type, in schema order: the zod enums derive from this, never a copy. */
export const RESOURCE_TYPES = Object.keys(RESOURCE_KINDS) as [ResourceType, ...ResourceType[]];

export function isResourceType(value: unknown): value is ResourceType {
  return typeof value === 'string' && Object.hasOwn(RESOURCE_KINDS, value);
}

/**
 * The noun for one resource. A type this build does not know reads as a
 * court rather than throwing: the copy is the one place a value from a newer
 * server should degrade instead of failing the page.
 */
export function resourceNoun(type: string | null | undefined): ResourceNoun {
  return isResourceType(type) ? RESOURCE_KINDS[type].noun : 'court';
}

/** The noun for a list: its one noun, `mixed` for courts and tracks together, `court` when empty. */
export function combineNouns(nouns: Iterable<ResourceNoun>): ResourceNouns {
  const seen = new Set(nouns);
  if (seen.size > 1) return 'mixed';
  return seen.values().next().value ?? 'court';
}

/** `combineNouns` over resource types, as a list of rows has them. */
export function resourceNouns(types: Iterable<string | null | undefined>): ResourceNouns {
  return combineNouns(Array.from(types, resourceNoun));
}
