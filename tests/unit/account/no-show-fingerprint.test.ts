/**
 * @jest-environment node
 */
import {
  NO_SHOW_FINGERPRINT_INFO,
  noShowFingerprint,
  normaliseAddress,
} from '@/lib/account/no-show-fingerprint';

/**
 * The keyed fingerprint a deleted account's carried no-show standing waits
 * under (#370 review, P53): stable for an address however it is typed, never
 * the address, and gone when the base key changes.
 */
describe('noShowFingerprint', () => {
  const previous = process.env.DATA_ENCRYPTION_KEY;
  afterEach(() => {
    if (previous === undefined) delete process.env.DATA_ENCRYPTION_KEY;
    else process.env.DATA_ENCRYPTION_KEY = previous;
  });

  it('is the same for the address as sign-in compares it, whatever the case or spaces', () => {
    expect(normaliseAddress('  Maria@Example.BG ')).toBe('maria@example.bg');
    expect(noShowFingerprint('Maria@Example.BG')).toBe(noShowFingerprint(' maria@example.bg '));
  });

  it('is 64 hex characters that do not contain the address', () => {
    const fp = noShowFingerprint('maria@example.bg');
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
    expect(fp).not.toContain('maria');
    expect(noShowFingerprint('petar@example.bg')).not.toBe(fp);
  });

  it('is keyed: not a plain hash of the address', async () => {
    const { createHash } = await import('node:crypto');
    const plain = createHash('sha256').update('maria@example.bg').digest('hex');
    expect(noShowFingerprint('maria@example.bg')).not.toBe(plain);
  });

  it('rotating DATA_ENCRYPTION_KEY gives every address a new fingerprint (the carry-over ends)', () => {
    process.env.DATA_ENCRYPTION_KEY = 'a'.repeat(48);
    const before = noShowFingerprint('maria@example.bg');
    process.env.DATA_ENCRYPTION_KEY = 'b'.repeat(48);
    expect(noShowFingerprint('maria@example.bg')).not.toBe(before);
    process.env.DATA_ENCRYPTION_KEY = 'a'.repeat(48);
    expect(noShowFingerprint('maria@example.bg')).toBe(before);
  });

  it('has a label of its own, so it is not any other key derived from the same base', () => {
    expect(NO_SHOW_FINGERPRINT_INFO).toBe('playerz/no-show-fingerprint/v1');
  });
});
