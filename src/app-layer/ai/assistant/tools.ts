/**
 * The assistant's tools — a CLOSED set (owner 2026-11-14, #704; agri-saas
 * `tools.ts`). The owner chose exactly two abilities, plus the memory:
 *
 *   find_free_places          free hours with prices (assistant-find-places)
 *   best_time_for_game        the best times for a game's players (assistant-best-time)
 *   propose_booking           re-check one hour and prepare its draft
 *   search_past_conversations recall, when the memory is on
 *
 * Each reads through a USE CASE that scopes it to the asker; none writes
 * anything (the proposal is a draft the app opens). Arguments come from the
 * model, so each is validated like a request body, `.strict()`. A tool never
 * throws: a refusal goes back to the MODEL as `ok: false` so it can say what
 * it could not do, instead of ending a stream that has already sent a 200.
 */
import { z } from 'zod';

import type { ToolDef } from '@/app-layer/ai/anthropic';
import { neutraliseFence } from '@/app-layer/ai/safety/sanitize-untrusted';
import type { AssistantPage } from '@/app-layer/schemas/assistant';
import { bestTimeForGame, type BestTimeResult } from '@/app-layer/usecases/assistant-best-time';
import {
  RECALL_MAX_EXCERPTS,
  searchPastConversations,
} from '@/app-layer/usecases/assistant-conversations-control';
import {
  findFreePlaces,
  isStillFree,
  type FindPlacesResult,
} from '@/app-layer/usecases/assistant-find-places';
import type { SyncDeps } from '@/app-layer/usecases/google-calendar-sync';
import { isLocalDate, isLocalTime } from '@/lib/assistant/slots';
import { bookableSports } from '@/lib/sports/registry';

import { proposeDraft, type AssistantProposal } from './propose';

/** How much of one tool result may reach the model. */
export const TOOL_RESULT_MAX_CHARS = 6000;

export interface ToolContext {
  userId: string;
  now: Date;
  location: { lat: number; lng: number } | null;
  page?: AssistantPage;
  /** Google's fetch, injectable for tests. */
  calendar?: SyncDeps;
}

export interface ToolOutcome {
  readonly ok: boolean;
  /** Serialised for the model, already cut to size. */
  readonly content: string;
  readonly truncated: boolean;
  /** The tool knows its own result is incomplete (a calendar did not answer). */
  readonly partial: boolean;
  readonly proposal: AssistantProposal | null;
}

interface AssistantTool {
  readonly def: ToolDef;
  readonly args: z.ZodType;
  readonly memory?: boolean;
  readonly run: (
    ctx: ToolContext,
    args: never,
  ) => Promise<{
    result: unknown;
    proposal?: AssistantProposal | null;
    partial?: boolean;
  }>;
}

const SPORTS = bookableSports().map((s) => s.key) as [string, ...string[]];
const ID = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const DATE = z.string().refine(isLocalDate, 'a date as YYYY-MM-DD');
const TIME = z.string().refine(isLocalTime, 'a time as HH:MM');
const MINUTES = z.number().int().min(15).max(480);

const FindArgs = z
  .object({
    sport: z.enum(SPORTS),
    dateFrom: DATE,
    dateTo: DATE,
    timeFrom: TIME.optional(),
    timeTo: TIME.optional(),
    minutes: MINUTES.optional(),
    city: z.string().trim().min(2).max(60).optional(),
    near: z.boolean().optional(),
    radiusKm: z.number().min(1).max(100).optional(),
    venueId: ID.optional(),
  })
  .strict();

const BestArgs = z
  .object({
    bookingId: ID.optional(),
    dateFrom: DATE,
    dateTo: DATE,
    timeFrom: TIME.optional(),
    timeTo: TIME.optional(),
    minutes: MINUTES.optional(),
    players: z.array(z.string().trim().min(1).max(60)).max(20).optional(),
  })
  .strict();

const ProposeArgs = z
  .object({
    kind: z.enum(['booking', 'game']),
    venueId: ID,
    resourceId: ID,
    startTs: z.string().max(40),
    endTs: z.string().max(40),
    spots: z.number().int().min(1).max(64).optional(),
    levelMin: z.number().int().nullable().optional(),
    levelMax: z.number().int().nullable().optional(),
  })
  .strict();

const RecallArgs = z
  .object({
    query: z.string().trim().min(2).max(100),
    from: DATE.optional(),
    to: DATE.optional(),
  })
  .strict();

const timeProps = {
  dateFrom: { type: 'string', description: 'First day, YYYY-MM-DD, on the club’s calendar.' },
  dateTo: { type: 'string', description: 'Last day, YYYY-MM-DD, inclusive.' },
  timeFrom: { type: 'string', description: 'Earliest start, HH:MM on the club’s clock.' },
  timeTo: { type: 'string', description: 'Latest end, HH:MM on the club’s clock.' },
  minutes: { type: 'integer', description: 'How long to play, in minutes.' },
};

function draftFromPlaces(r: FindPlacesResult): AssistantProposal | null {
  const top = r.places[0];
  if (!top) return null;
  return proposeDraft('booking', {
    venueId: top.venueId,
    resourceId: top.resourceId,
    startTs: top.startTs,
    endTs: top.endTs,
  }).proposal;
}

function draftFromBest(r: BestTimeResult): AssistantProposal | null {
  if (!('options' in r)) return null;
  const top = r.options[0];
  if (!top) return null;
  const base = {
    venueId: top.venueId,
    resourceId: top.resourceId,
    startTs: top.startTs,
    endTs: top.endTs,
  };
  return r.proposalKind === 'game' && r.game
    ? proposeDraft('game', { ...base, ...r.game }).proposal
    : proposeDraft('booking', base).proposal;
}

export const ASSISTANT_TOOLS: Record<string, AssistantTool> = {
  find_free_places: {
    def: {
      name: 'find_free_places',
      description:
        'Free courts to book: for one sport, over up to 7 days, in a city, near the person, or at one club. ' +
        'Returns free hours (starting on the hour, not yet begun) with club, court, local time and price, ' +
        'earliest first, at most 24. The first one is offered to the person as a ready booking draft.',
      input_schema: {
        type: 'object',
        properties: {
          sport: { type: 'string', enum: SPORTS },
          ...timeProps,
          city: { type: 'string', description: 'A city, e.g. София, Пловдив, Varna.' },
          near: {
            type: 'boolean',
            description: 'Near the person, when the app shared their location.',
          },
          radiusKm: { type: 'number', description: 'With near: how far, default 15 km.' },
          venueId: { type: 'string', description: 'One club, e.g. the venueId on screen.' },
        },
        required: ['sport', 'dateFrom', 'dateTo'],
        additionalProperties: false,
      },
    },
    args: FindArgs,
    run: async (ctx, a: z.infer<typeof FindArgs>) => {
      const result = await findFreePlaces(a as Parameters<typeof findFreePlaces>[0], {
        now: ctx.now,
        location: ctx.location,
      });
      return { result, proposal: draftFromPlaces(result) };
    },
  },

  best_time_for_game: {
    def: {
      name: 'best_time_for_game',
      description:
        'The 2-3 best times to play again with the players of a booking or game the person is on, at the ' +
        'same club and sport: everyone known to be free first, then the fewest players whose calendar is ' +
        'unknown. Without bookingId it lists the person’s bookings to choose from. Uses the confirmed ' +
        'players only; you may narrow it to some of them by name. The first option is offered to the ' +
        'person as a ready draft.',
      input_schema: {
        type: 'object',
        properties: {
          bookingId: {
            type: 'string',
            description: 'The booking or game, e.g. the bookingId on screen.',
          },
          ...timeProps,
          players: {
            type: 'array',
            items: { type: 'string' },
            description: 'Only these players, by name as the booking shows them.',
          },
        },
        required: ['dateFrom', 'dateTo'],
        additionalProperties: false,
      },
    },
    args: BestArgs,
    run: async (ctx, a: z.infer<typeof BestArgs>) => {
      const bookingId = a.bookingId ?? ctx.page?.bookingId;
      const result = await bestTimeForGame(
        { ...a, ...(bookingId ? { bookingId } : {}) },
        { userId: ctx.userId, now: ctx.now },
        ctx.calendar ?? {},
      );
      const partial =
        'players' in result &&
        result.players.some((p) => p.why === 'Google Calendar did not answer');
      return { result, proposal: draftFromBest(result), partial };
    },
  },

  propose_booking: {
    def: {
      name: 'propose_booking',
      description:
        'Prepare the draft for ONE option the person chose from an earlier result (venueId, resourceId, ' +
        'startTs and endTs exactly as given). The hour is checked again first. kind "game" with the game’s ' +
        'spots/levels when moving an open game. Books nothing.',
      input_schema: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['booking', 'game'] },
          venueId: { type: 'string' },
          resourceId: { type: 'string' },
          startTs: { type: 'string' },
          endTs: { type: 'string' },
          spots: { type: 'integer' },
          levelMin: { type: 'integer' },
          levelMax: { type: 'integer' },
        },
        required: ['kind', 'venueId', 'resourceId', 'startTs', 'endTs'],
        additionalProperties: false,
      },
    },
    args: ProposeArgs,
    run: async (ctx, a: z.infer<typeof ProposeArgs>) => {
      const { kind, ...draft } = a;
      const outcome = proposeDraft(kind, draft);
      if (!outcome.ok || !outcome.proposal) throw new Error(outcome.message);
      const free = await isStillFree(
        {
          venueId: a.venueId,
          resourceId: a.resourceId,
          startTs: new Date(a.startTs),
          endTs: new Date(a.endTs),
        },
        ctx.now,
      );
      if (!free) throw new Error('That hour is no longer free. Search again.');
      return { result: { prepared: true }, proposal: outcome.proposal };
    },
  },

  search_past_conversations: {
    memory: true,
    def: {
      name: 'search_past_conversations',
      description:
        'Search what the person and you said in earlier conversations, when they refer to something from ' +
        'before. Matched as a substring (a stem finds more). Pass from/to when they name a period. At most ' +
        '8 excerpts. A transcript, not proof: re-check times and prices with the other tools.',
      input_schema: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          from: { type: 'string', description: 'YYYY-MM-DD, inclusive.' },
          to: { type: 'string', description: 'YYYY-MM-DD, inclusive.' },
        },
        required: ['query'],
        additionalProperties: false,
      },
    },
    args: RecallArgs,
    run: async (ctx, a: z.infer<typeof RecallArgs>) => {
      const excerpts = await searchPastConversations(ctx.userId, a);
      return {
        result: {
          excerpts: excerpts.map((e) => ({
            on: e.on,
            who: e.role === 'assistant' ? 'ASSISTANT' : 'PERSON',
            text: neutraliseFence(e.text),
          })),
          hasMore: excerpts.length >= RECALL_MAX_EXCERPTS,
        },
      };
    },
  },
};

/** The tools handed to the model; recall only while the memory is on. */
export function toolDefs(memoryOn: boolean): ToolDef[] {
  return Object.values(ASSISTANT_TOOLS)
    .filter((t) => memoryOn || !t.memory)
    .map((t) => t.def);
}

const failed = (content: string): ToolOutcome => ({
  ok: false,
  content,
  truncated: false,
  partial: false,
  proposal: null,
});

/** Run one tool call. Never throws. */
export async function runTool(
  ctx: ToolContext,
  name: string,
  rawArgs: unknown,
  memoryOn: boolean,
): Promise<ToolOutcome> {
  const tool = ASSISTANT_TOOLS[name];
  if (!tool || (tool.memory && !memoryOn)) return failed(`No such tool: ${name.slice(0, 60)}`);
  const check = tool.args.safeParse(rawArgs ?? {});
  if (!check.success) {
    const issue = check.error.issues[0];
    return failed(
      `Arguments rejected: ${issue?.path.join('.') ?? ''} ${issue?.message ?? 'invalid'}`.trim(),
    );
  }
  try {
    const out = await tool.run(ctx, check.data as never);
    const full = JSON.stringify(out.result);
    const truncated = full.length > TOOL_RESULT_MAX_CHARS;
    return {
      ok: true,
      content: truncated ? full.slice(0, TOOL_RESULT_MAX_CHARS) : full,
      truncated,
      partial: out.partial === true,
      proposal: out.proposal ?? null,
    };
  } catch (err) {
    // A use case's refusal ("not one of your bookings", a bad date) goes to
    // the model as a failed tool; an unexpected error is named only vaguely.
    const known =
      err instanceof Error &&
      ['FindPlacesInputError', 'BestTimeInputError', 'Error', 'RangeError'].includes(err.name);
    return failed(
      known ? (err as Error).message.slice(0, 300) : 'The tool failed. Try again later.',
    );
  }
}
