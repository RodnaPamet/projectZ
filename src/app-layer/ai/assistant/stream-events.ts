/**
 * The assistant's SSE events (agri-saas #2578), as the phone reads them.
 *
 * Wire format: `data: <json>\n\n`, no `event:` line. The client switches on
 * the payload's own `type`, so a new type later is ignored by an older app
 * rather than breaking it.
 *
 *   `conversation` — FIRST, before any work: the id to send back as
 *                    `conversationId` with the next question. An app that
 *                    loses the stream mid-answer still holds it.
 *   `thinking`     — the question was accepted and work started.
 *   `tool_call`    — a tool is being read, named before its result arrives.
 *   `tool_result`  — whether it worked, and whether it was cut short.
 *   `answer`       — the answer. ONE event, scanned whole before it is sent;
 *                    with at most one `proposal`.
 *   `refusal`      — no answer, with its reason (`code` + `message`).
 *   `halt`         — the answer above is real but incomplete, or the model
 *                    could not be used; `code` + `message`.
 *   `done`         — the end. ALWAYS last, also after a `halt`: a client that
 *                    stops at `halt` loses `truncatedAny` / `partialAny`.
 *
 * There is no `error` event, deliberately: every ending a person should see
 * carries a reason they can act on.
 */
import type { HaltCode, RefusalCode } from './endings';
import type { AssistantProposal } from './propose';

export type AssistantStreamEvent =
  | { readonly type: 'conversation'; readonly conversationId: string }
  | { readonly type: 'thinking' }
  | { readonly type: 'tool_call'; readonly name: string }
  | {
      readonly type: 'tool_result';
      readonly name: string;
      readonly ok: boolean;
      readonly truncated: boolean;
    }
  | {
      readonly type: 'answer';
      readonly text: string;
      /**
       * A PREPARED draft. Nothing is written: the app opens its usual form
       * prefilled with it and the person submits that form, so every rule on
       * the normal create path applies unchanged. Absent when there is none.
       */
      readonly proposal?: AssistantProposal;
    }
  | { readonly type: 'refusal'; readonly code: RefusalCode; readonly message: string }
  | { readonly type: 'halt'; readonly code: HaltCode; readonly message: string }
  | { readonly type: 'done'; readonly truncatedAny: boolean; readonly partialAny: boolean };

export function sseFormat(event: AssistantStreamEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}
