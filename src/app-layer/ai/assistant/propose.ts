/**
 * The assistant PREPARES a draft; the person confirms it (agri-saas
 * `propose.ts`). It never books, never opens a game, never writes anything.
 *
 * A proposal is `{ kind, draft }`, and the draft is in the shape of a body the
 * app already posts, so the app opens its usual screen prefilled and the
 * person submits it there — every rule, price and check of the normal path
 * applies unchanged:
 *
 *   `booking` — `{ venueId, resourceId, startTs, endTs }`: the body of
 *               `POST /t/{slug}/bookings` (`createBookingBodySchema`), plus
 *               the venue, which the reservation summary opens by.
 *   `game`    — the booking draft plus `{ spots, levelMin?, levelMax? }`: the
 *               booking above, then `PUT /me/bookings/{id}/game`
 *               (`openGameBodySchema`) on the booking it creates. Proposed
 *               when the game being moved is an open game.
 *
 * The fields are lifted from the production schemas' shapes, so a renamed
 * field fails at module load rather than prefilling nothing. `.strict()`: a
 * draft carrying anything else (a price, a note the model wrote) is refused,
 * never silently stripped.
 */
import { z } from 'zod';

import { createBookingBodySchema } from '@/app-layer/schemas/booking';
import { openGameBodySchema } from '@/app-layer/schemas/open-play';

export const PROPOSAL_KINDS = ['booking', 'game'] as const;
export type ProposalKind = (typeof PROPOSAL_KINDS)[number];

export interface AssistantProposal {
  readonly kind: ProposalKind;
  readonly draft: Record<string, unknown>;
}

const RECORD_ID = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, 'not an id');

function field<T extends object, K extends keyof T & string>(shape: T, key: K, from: string): T[K] {
  const f = shape[key];
  if (!f) {
    throw new Error(
      `propose.ts: "${key}" is not a field of ${from}. Update the draft with the body.`,
    );
  }
  return f;
}

const booking = createBookingBodySchema.shape;
const game = openGameBodySchema.shape;

export const BookingDraftSchema = z
  .object({
    venueId: RECORD_ID,
    resourceId: field(booking, 'resourceId', 'createBookingBodySchema'),
    startTs: field(booking, 'startTs', 'createBookingBodySchema'),
    endTs: field(booking, 'endTs', 'createBookingBodySchema'),
  })
  .strict();

export const GameDraftSchema = BookingDraftSchema.extend({
  spots: field(game, 'spots', 'openGameBodySchema'),
  levelMin: field(game, 'levelMin', 'openGameBodySchema'),
  levelMax: field(game, 'levelMax', 'openGameBodySchema'),
}).strict();

export const PROPOSAL_SCHEMAS: Readonly<Record<ProposalKind, z.ZodType>> = {
  booking: BookingDraftSchema,
  game: GameDraftSchema,
};

export interface ProposalOutcome {
  readonly ok: boolean;
  readonly proposal: AssistantProposal | null;
  /** For the MODEL: why a draft was refused, so it can correct it. */
  readonly message: string;
}

/** Validate a draft. Writes nothing; never throws. */
export function proposeDraft(kind: ProposalKind, draft: unknown): ProposalOutcome {
  const parsed = PROPOSAL_SCHEMAS[kind].safeParse(draft);
  if (!parsed.success) {
    return {
      ok: false,
      proposal: null,
      message: `Draft rejected: ${parsed.error.issues[0]?.message ?? 'invalid'}`,
    };
  }
  const d = parsed.data as Record<string, unknown>;
  if (Date.parse(String(d.endTs)) <= Date.parse(String(d.startTs))) {
    return { ok: false, proposal: null, message: 'Draft rejected: endTs is not after startTs' };
  }
  // Absent rather than null, so the app need not tell the two apart.
  const draftOut = Object.fromEntries(
    Object.entries(d).filter(([, v]) => v !== undefined && v !== null),
  );
  return {
    ok: true,
    proposal: { kind, draft: draftOut },
    message: 'Draft prepared. The person confirms it in the app; nothing has been booked.',
  };
}
