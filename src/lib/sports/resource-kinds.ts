import type { ResourceType } from '@prisma/client';

/**
 * WHAT A BOOKABLE RESOURCE IS CALLED (P51, #454).
 *
 * Booking, availability and pricing never look at a resource's type: a karting
 * TRACK is held, priced and refused exactly as a padel COURT is. What the type
 * changes is the COPY. A track is a "писта" and a field an "игрище", and every
 * sentence about one agrees with its noun ("Пистата ще се освободи",
 * "Игрището е активно"). The UI picks its wording from
 * `resourceNoun(resourceType)`, never from the sport.
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
 * catalogue mirrors: the court wording is a key's plain path, a noun's own
 * wording the same path with the noun after the namespace the component binds
 * (`track.`, `pitch.`), and the wording for a list holding several nouns the
 * same path with the list's name (`courtTrack.`, see `ResourceNouns`).
 *
 * A FIELD's noun is `pitch`, its English word, as `court` and `track` are
 * theirs: `field.` was taken, by the forms' field labels
 * (`admin.courts.field.setting` is the label "Разположение", where a noun's
 * layout would need `admin.courts.field.setting.indoor`).
 *
 * ═══ A LIST OF SEVERAL NOUNS IS COMPOSED, NOT SPELLED OUT (#477) ═══
 *
 * With five nouns there are 26 lists of two or more, and a message worded
 * for each would put hundreds of strings in a catalogue every page carries.
 * So a message that can name several nouns has ONE wording for them, under
 * `several.`, with a `{nouns}` slot; the slot is filled from each noun's
 * forms in `nouns.*` (`nounList` in noun-list.ts), joined as the language
 * joins a list ("кортове, маси и места").
 */

/**
 * The noun a resource takes in copy: "писта", "игрище" (a FIELD), "маса" (a
 * TABLE or a BOARD_TABLE: table tennis, chess), "място" (a LOBBY: esports;
 * owner decisions on #477), or "корт" for every other type.
 */
export type ResourceNoun = 'court' | 'pitch' | 'track' | 'table' | 'seat';

/** The order a list names its nouns in (owner, #454; #477): "Кортове, игрища, писти, маси и места". */
export const NOUN_ORDER = [
  'court',
  'pitch',
  'track',
  'table',
  'seat',
] as const satisfies readonly ResourceNoun[];

/** Every non-empty ordered subset of `T`, each named by its nouns in camel case. */
type Lists<T extends readonly string[]> = T extends readonly [
  infer H extends string,
  ...infer R extends readonly string[],
]
  ? H | `${H}${Capitalize<Lists<R>>}` | Lists<R>
  : never;

/**
 * The nouns of a LIST of resources: its one noun, or the several it holds,
 * named by them in `NOUN_ORDER` (`courtPitch` is courts and pitches,
 * `courtTableSeat` courts, tables and seats). An empty list reads as courts.
 */
export type ResourceNouns = Lists<typeof NOUN_ORDER>;

/** Every value a list's nouns can take, for an enum that carries one (the statement's). */
export const RESOURCE_NOUNS: readonly ResourceNouns[] = (() => {
  const out: string[] = [];
  const n = NOUN_ORDER.length;
  for (let mask = 1; mask < 1 << n; mask++) {
    const held = NOUN_ORDER.filter((_, i) => mask & (1 << i));
    out.push(held.map((w, i) => (i === 0 ? w : w[0]!.toUpperCase() + w.slice(1))).join(''));
  }
  return out as ResourceNouns[];
})();

/** The nouns a list's name holds, in order: `courtTable` is court and table. */
export function nounsOf(list: ResourceNouns): ResourceNoun[] {
  return list.split(/(?=[A-Z])/).map((w) => w.toLowerCase() as ResourceNoun);
}

/**
 * What a venue's page title offers to book (#362, #477): "резервирай корт",
 * "писта", "игрище", "маса", "място", or "час" (a time) when no one word is
 * true of the venue. Wider than `ResourceNoun` on purpose: a climbing route
 * reads "корт" in the rest of the copy, while a search result for one offers
 * a time.
 */
export type BookingNoun = 'court' | 'track' | 'pitch' | 'table' | 'seat' | 'time';

interface ResourceKind {
  noun: ResourceNoun;
  /**
   * The title's word for a venue whose every resource is of this type. A type
   * with no word of its own there (a climbing route) offers a time:
   * "резервирай корт" would name the wrong thing in a search result.
   */
  booking: BookingNoun;
  /**
   * Only the sports the registry puts on this type may use it, and they may
   * use nothing else (`allowedResourceTypes` in resources.ts).
   */
  exclusive: boolean;
}

export const RESOURCE_KINDS: Record<ResourceType, ResourceKind> = {
  COURT: { noun: 'court', booking: 'court', exclusive: false },
  FIELD: { noun: 'pitch', booking: 'pitch', exclusive: false },
  TABLE: { noun: 'table', booking: 'table', exclusive: false },
  BOARD_TABLE: { noun: 'table', booking: 'table', exclusive: false },
  LOBBY: { noun: 'seat', booking: 'seat', exclusive: false },
  ROUTE: { noun: 'court', booking: 'time', exclusive: false },
  TRACK: { noun: 'track', booking: 'track', exclusive: true },
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

/**
 * The nouns of a list: its one noun, the several it holds named in
 * `NOUN_ORDER` (courts and pitches: `courtPitch`), `court` when empty.
 */
export function combineNouns(nouns: Iterable<ResourceNoun>): ResourceNouns {
  const seen = new Set(nouns);
  const [first = 'court', ...rest] = NOUN_ORDER.filter((n) => seen.has(n));
  return (first + rest.map((n) => n[0]!.toUpperCase() + n.slice(1)).join('')) as ResourceNouns;
}

/** `combineNouns` over resource types, as a list of rows has them. */
export function resourceNouns(types: Iterable<string | null | undefined>): ResourceNouns {
  return combineNouns(Array.from(types, resourceNoun));
}

/**
 * What a venue offers to book, from its resources' types: their one booking
 * word, a time when they have several (a padel court and a football pitch, or
 * a court and a track), and a court when there are none, as an empty list
 * reads everywhere else. A type this build does not know counts as a court, as
 * `resourceNoun` reads it.
 */
export function bookingNoun(types: Iterable<string | null | undefined>): BookingNoun {
  const seen = new Set(
    Array.from(types, (t): BookingNoun =>
      isResourceType(t) ? RESOURCE_KINDS[t].booking : 'court',
    ),
  );
  if (seen.size > 1) return 'time';
  return seen.values().next().value ?? 'court';
}
