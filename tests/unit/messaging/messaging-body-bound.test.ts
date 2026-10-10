import { readFileSync } from 'node:fs';

import { sendMessageBodySchema } from '@/app-layer/schemas/messaging';
import { BODY_VALIDATOR_MAX, MAX_BODY_LENGTH } from '@/lib/messaging/limits';
import { decodeCursor, encodeCursor } from '@/lib/messaging/cursor';

/**
 * The documented message bound IS the enforced one (#375), ported from
 * agri-saas `tests/contracts/exchange-body-bound.test.ts`.
 *
 * There the spec said 8000 while the server refused anything over 4000 —
 * exactly 2x — and a client trusting the document was refused with a code the
 * document did not list (#1391). This asserts the IDENTITY, so one edit moves
 * both, and an edit to only one fails here.
 *
 * It does NOT assert that the request validator equals the bound: it is looser
 * on purpose, because the use case measures after sanitising and a validator
 * at the bound would make `MESSAGE_TOO_LONG` unreachable.
 */

const spec = JSON.parse(readFileSync('openapi/playerz-v1.json', 'utf8')) as {
  components: {
    schemas: Record<string, { properties?: Record<string, { maxLength?: number }> }>;
  };
};

describe('the documented message bound is the enforced one', () => {
  const body = spec.components.schemas.SendMessageRequest?.properties?.body;

  it('control: the spec describes the field', () => {
    expect(typeof body?.maxLength).toBe('number');
  });

  it('documented maxLength IS the use case’s bound', () => {
    expect(body?.maxLength).toBe(MAX_BODY_LENGTH);
  });

  it('the validator is looser than the documented bound, deliberately', () => {
    expect(BODY_VALIDATOR_MAX).toBeGreaterThan(MAX_BODY_LENGTH);
    const over = 'x'.repeat(MAX_BODY_LENGTH + 1);
    expect(sendMessageBodySchema.safeParse({ body: over }).success).toBe(true);
    expect(
      sendMessageBodySchema.safeParse({ body: 'x'.repeat(BODY_VALIDATOR_MAX + 1) }).success,
    ).toBe(false);
  });
});

describe('messaging cursors', () => {
  it('round-trip one row exactly, and are opaque', () => {
    const row = { at: new Date('2026-10-10T08:00:00.123Z'), id: 'cabc123' };
    const raw = encodeCursor(row)!;
    expect(raw).not.toContain('2026');
    expect(decodeCursor(raw)).toEqual(row);
  });

  it('a malformed cursor restarts the listing rather than failing or matching nothing', () => {
    for (const bad of [
      '',
      'x',
      Buffer.from('nonsense|id').toString('base64url'),
      'a'.repeat(201),
    ]) {
      expect(decodeCursor(bad)).toBeNull();
    }
  });
});
