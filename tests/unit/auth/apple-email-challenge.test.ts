/**
 * @jest-environment node
 */
import {
  APPLE_CODE_TTL_MS,
  APPLE_TICKET_TTL_MS,
  codeMatches,
  newAppleCode,
  readAppleCodeChallenge,
  readAppleTicket,
  signAppleCodeChallenge,
  signAppleTicket,
} from '@/lib/account/apple-email-challenge';

/**
 * THE HIDDEN-ADDRESS STEP CARRIES ITS STATE IN TWO SIGNED TOKENS (#442).
 *
 * Nothing is stored between "Apple hid the address", "send a code" and
 * "confirm the code", so everything the steps need is in the tokens, and a
 * token is good only unaltered, unexpired, and for its own step.
 */

const NOW = 1_800_000_000_000;
const ticket = { subject: '001234.abcdef.1200', name: 'Петя Иванова', locale: 'bg' };

describe('the ticket', () => {
  it('reads back what was signed, for 30 minutes', () => {
    const token = signAppleTicket(ticket, NOW);
    expect(readAppleTicket(token, NOW)).toEqual({
      ...ticket,
      expiresAt: NOW + APPLE_TICKET_TTL_MS,
    });
    expect(readAppleTicket(token, NOW + APPLE_TICKET_TTL_MS)).toBeNull();
  });

  it('is refused altered, truncated, or not a token at all', () => {
    const token = signAppleTicket(ticket, NOW);
    const [payload, tag] = token.split('.');
    const forged = Buffer.from(
      JSON.stringify({ k: 't', s: 'someone-else', n: null, l: null, x: NOW + 1e9 }),
    ).toString('base64url');
    expect(readAppleTicket(`${forged}.${tag}`, NOW)).toBeNull();
    expect(readAppleTicket(`${payload}.`, NOW)).toBeNull();
    expect(readAppleTicket(payload, NOW)).toBeNull();
    expect(readAppleTicket(42, NOW)).toBeNull();
  });
});

describe('the code challenge', () => {
  const read = () => readAppleTicket(signAppleTicket(ticket, NOW), NOW)!;

  it('carries the ticket and the address, for 10 minutes, and matches only its own code', () => {
    const code = '042517';
    const token = signAppleCodeChallenge(read(), 'petya@example.bg', code, NOW);
    const challenge = readAppleCodeChallenge(token, NOW)!;
    expect(challenge).toMatchObject({ ...ticket, email: 'petya@example.bg' });
    expect(challenge.expiresAt).toBe(NOW + APPLE_CODE_TTL_MS);

    expect(codeMatches(challenge, code)).toBe(true);
    expect(codeMatches(challenge, '042518')).toBe(false);
    expect(codeMatches(challenge, '42517')).toBe(false);
    expect(codeMatches(challenge, 'abcdef')).toBe(false);
    expect(readAppleCodeChallenge(token, NOW + APPLE_CODE_TTL_MS)).toBeNull();
  });

  it('never holds the code itself', () => {
    const code = '987654';
    const token = signAppleCodeChallenge(read(), 'a@b.bg', code, NOW);
    const payload = Buffer.from(token.split('.')[0], 'base64url').toString('utf8');
    expect(payload).not.toContain(code);
  });

  it('a code made for one address does not confirm another', () => {
    const t = read();
    const forA = readAppleCodeChallenge(signAppleCodeChallenge(t, 'a@b.bg', '111111', NOW), NOW)!;
    const forB = readAppleCodeChallenge(signAppleCodeChallenge(t, 'b@b.bg', '111111', NOW), NOW)!;
    expect(codeMatches({ ...forB, codeTag: forA.codeTag }, '111111')).toBe(false);
  });

  it('a ticket is not a challenge, and a challenge is not a ticket', () => {
    const t = signAppleTicket(ticket, NOW);
    const c = signAppleCodeChallenge(read(), 'a@b.bg', '123456', NOW);
    expect(readAppleCodeChallenge(t, NOW)).toBeNull();
    expect(readAppleTicket(c, NOW)).toBeNull();
  });
});

describe('newAppleCode', () => {
  it('is six digits, leading zeros kept', () => {
    for (let i = 0; i < 200; i++) expect(newAppleCode()).toMatch(/^\d{6}$/);
  });
});
