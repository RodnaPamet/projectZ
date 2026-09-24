import { readFileSync, globSync } from 'node:fs';

/**
 * A SCHEMA COMMENT CLAIMING ENCRYPTION MUST BE TRUE.
 *
 * ═══ WHY THIS EXISTS ═══
 *
 * Nine fields across six models carried `/// Encrypted at rest`. None of them
 * was encrypted. The claim traced back to `src/lib/security/encrypted-fields.ts`,
 * a manifest listing six model:field pairs with a rationale each — and with
 * zero callers, whose own comment said `encryptedFieldPairs()` was "used by the
 * guardrail" when no guardrail used it.
 *
 * The manifest and reality were disjoint sets: the only encrypted columns in
 * the database are the wearable OAuth tokens, and NEITHER of them was in the
 * manifest.
 *
 * That is worse than no claim at all. `User.mfaSecret` read "Encrypted at rest
 * — never a plaintext TOTP seed", so whoever implements MFA would reasonably
 * believe a mechanism was waiting to encrypt it. Nothing was. The comment
 * described a protection that would silently not happen.
 *
 * ═══ WHY AN ALLOWLIST AND NOT A DETECTOR ═══
 *
 * "Is this column encrypted?" cannot be answered by reading the schema — the
 * encryption happens in application code, on whichever paths happen to call
 * it. So the claim has to be declared, and the declaration has to be short
 * enough that adding to it is a conscious act a reviewer sees.
 */

const SCHEMAS = globSync('prisma/schema/*.prisma').map((f) => f.toString());

/**
 * Fields whose values genuinely are ciphertext in the database.
 *
 * `encryptField` is applied to both on write and `decryptField` on read, in
 * src/app-layer/usecases/wearables.ts. Adding a line here means the write path
 * exists — not that it is planned.
 */
const ACTUALLY_ENCRYPTED = ['accessTokenEnc', 'refreshTokenEnc'];

/**
 * A doc comment that promises ciphertext.
 *
 * Two forms, deliberately narrow: the phrase "encrypted at rest" anywhere, or
 * a comment that OPENS with "Encrypted". Matching a bare `\bencrypted\b`
 * anywhere flags prose that merely mentions encryption — including the honest
 * note on Booking.notes explaining why it used to claim it.
 */
const CLAIMS_ENCRYPTION = /encrypted at rest\b|^\s*\/\/\/\s*Encrypted\b/i;

describe('every schema comment claiming encryption is true', () => {
  it('the scan found the schema files', () => {
    // A broken glob would make the assertion below vacuous.
    expect(SCHEMAS.length).toBeGreaterThanOrEqual(5);
    expect(SCHEMAS.some((f) => f.endsWith('wearables.prisma'))).toBe(true);
  });

  it('no field is described as encrypted unless it is', () => {
    const offenders: string[] = [];

    for (const file of SCHEMAS) {
      const lines = readFileSync(file, 'utf8').split('\n');

      lines.forEach((line, i) => {
        if (!CLAIMS_ENCRYPTION.test(line)) return;
        // "NOT encrypted" is the honest form, and says the opposite.
        if (/\bNOT\s+encrypted\b/i.test(line)) return;

        // The field a doc comment describes is the next non-comment,
        // non-blank line.
        const field = lines
          .slice(i + 1)
          .find((l) => l.trim() && !l.trim().startsWith('///'))
          ?.trim();
        if (!field) return;

        // A model- or enum-level doc comment describes the type, not a column.
        // `wearables.prisma` opens with "Tokens are ENCRYPTED at rest", which
        // is true of that model's fields and is not itself a field claim.
        if (/^(model|enum)\b/.test(field)) return;

        const name = field.split(/\s+/)[0];
        if (ACTUALLY_ENCRYPTED.includes(name)) return;

        offenders.push(`${file}:${i + 1}  ${name}  — ${line.trim()}`);
      });
    }

    if (offenders.length > 0) {
      throw new Error(
        `Schema comments promise encryption that does not happen:\n\n` +
          offenders.map((o) => `  ${o}`).join('\n') +
          `\n\nA column documented as ciphertext, that is not, is worse than one\n` +
          `documented as plaintext: the next person to handle that data trusts the\n` +
          `comment and does not add the protection themselves.\n\n` +
          `Either encrypt it on write and add the field to ACTUALLY_ENCRYPTED, or\n` +
          `write what is true — the honest form is "NOT encrypted", with a note on\n` +
          `what still has to happen before it ships.`,
      );
    }
  });

  it('the allowlist is not a dumping ground', () => {
    // Two fields, both wearable OAuth tokens. Growth here should be rare and
    // visible; a list that quietly reaches a dozen entries is the manifest
    // this guardrail replaced.
    expect(ACTUALLY_ENCRYPTED).toHaveLength(2);
  });

  it('the dead manifest has not come back', () => {
    // It documented six fields, none of them encrypted, and claimed a
    // guardrail consumed it. If a file by that name reappears, this rule is
    // the guardrail it should have been.
    expect(globSync('src/lib/security/encrypted-fields.ts')).toEqual([]);
  });
});
