import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto';

import { DEV_FALLBACK_DATA_ENCRYPTION_KEY } from '@/lib/security/encryption-constants';

/**
 * A coach's certificate (#377, owner decisions 13 and 17): the one document a
 * person uploads here that is never shown to anybody but the platform owner.
 *
 * ═══ WHY IT IS NOT A PHOTO ═══
 *
 * Photos go to the media bucket, which is public by address: whoever has the
 * link has the file. A coaching licence carries a name, a number, sometimes a
 * date of birth. So it is stored in the database (`coach_certificate`), where
 * row security decides who reads it, and it is SEALED before it is written:
 * a database dump, a backup in the bucket, or a query by an operator shows
 * ciphertext, not the document.
 *
 * ═══ THE SEAL ═══
 *
 *   0x01 | iv (12) | tag (16) | AES-256-GCM ciphertext
 *
 * Under a key derived by HKDF from DATA_ENCRYPTION_KEY with a label of its
 * own, as the phone challenge and the unsubscribe links are. Rotating the
 * base key makes stored certificates unreadable; the coach uploads again.
 * The leading byte is the version, so a later scheme can sit beside this one.
 *
 * ═══ WHAT IS ACCEPTED ═══
 *
 * A PDF, or a JPEG, PNG or WebP image, up to 5 MB, decided by the file's
 * first bytes and never by its name or the type the browser claimed. It is
 * not opened, converted or rendered on the server: it is handed back, as a
 * download, to a platform admin who asked for it.
 */

import {
  CERTIFICATE_MAX_BYTES,
  CERTIFICATE_TYPES,
  type CertificateMime,
} from './certificate-limits';

export { CERTIFICATE_MAX_BYTES, CERTIFICATE_TYPES, type CertificateMime };

export type CertificateRefusal = 'EMPTY' | 'TOO_LARGE' | 'NOT_A_CERTIFICATE';

export class CertificateRefusedError extends Error {
  constructor(readonly reason: CertificateRefusal) {
    super(reason);
    this.name = 'CertificateRefusedError';
  }
}

/** What the file IS, from its first bytes; null for anything else. */
export function sniffCertificateType(buf: Uint8Array): CertificateMime | null {
  const ascii = (from: number, to: number) =>
    Buffer.from(buf.subarray(from, to)).toString('latin1');
  if (ascii(0, 5) === '%PDF-') return 'application/pdf';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (
    buf[0] === 0x89 &&
    ascii(1, 4) === 'PNG' &&
    buf[4] === 0x0d &&
    buf[5] === 0x0a &&
    buf[6] === 0x1a &&
    buf[7] === 0x0a
  ) {
    return 'image/png';
  }
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp';
  return null;
}

/**
 * A name safe to store and to send back in a download header: the last path
 * segment, with control characters, quotes and slashes gone, at most 120
 * characters, and ending in the extension the CONTENT says it is.
 */
export function safeCertificateName(raw: unknown, mime: CertificateMime): string {
  const ext = CERTIFICATE_TYPES[mime];
  const last = (typeof raw === 'string' ? raw : '').split(/[\\/]/).pop() ?? '';
  const stem = last
    .replace(/\.[A-Za-z0-9]{1,5}$/, '')
    .replace(/[\u0000-\u001f\u007f"'<>:|?*\\/]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
  return `${stem || 'certificate'}.${ext}`;
}

export interface InspectedCertificate {
  mimeType: CertificateMime;
  fileName: string;
  byteSize: number;
  /** SHA-256 of the file as uploaded, hex. */
  sha256: string;
}

/** Decide whether these bytes are a certificate we keep, and describe them. */
export function inspectCertificate(bytes: Uint8Array, rawName: unknown): InspectedCertificate {
  if (bytes.byteLength === 0) throw new CertificateRefusedError('EMPTY');
  if (bytes.byteLength > CERTIFICATE_MAX_BYTES) throw new CertificateRefusedError('TOO_LARGE');
  const mimeType = sniffCertificateType(bytes);
  if (!mimeType) throw new CertificateRefusedError('NOT_A_CERTIFICATE');
  return {
    mimeType,
    fileName: safeCertificateName(rawName, mimeType),
    byteSize: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

// ─── The seal ───────────────────────────────────────────────────────────────

export const CERTIFICATE_KEY_INFO = 'playerz/coach-certificate/v1';
const SALT = 'playerz/coach-certificate/salt';
const VERSION = 0x01;
const IV_BYTES = 12;
const TAG_BYTES = 16;

function baseKeyMaterial(): string {
  const key = process.env.DATA_ENCRYPTION_KEY;
  if (key && key.length >= 32) return key;
  if (process.env.NODE_ENV === 'production') {
    throw new Error('DATA_ENCRYPTION_KEY is required in production (coach certificate).');
  }
  return DEV_FALLBACK_DATA_ENCRYPTION_KEY;
}

let cached: { material: string; key: Buffer } | null = null;

function sealingKey(): Buffer {
  const material = baseKeyMaterial();
  if (cached?.material === material) return cached.key;
  const key = Buffer.from(hkdfSync('sha256', material, SALT, CERTIFICATE_KEY_INFO, 32));
  cached = { material, key };
  return key;
}

/** Seal a file for storage. A fresh IV each time: sealing twice differs. */
export function sealCertificate(plain: Uint8Array): Buffer {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', sealingKey(), iv, { authTagLength: TAG_BYTES });
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([Buffer.from([VERSION]), iv, cipher.getAuthTag(), body]);
}

/**
 * Open a sealed file. Throws for anything this key did not seal: a truncated
 * blob, a flipped byte, another version, or a file sealed under a key since
 * rotated. Never returns bytes it could not authenticate.
 */
export function openCertificate(sealed: Uint8Array): Buffer {
  if (sealed.byteLength < 1 + IV_BYTES + TAG_BYTES || sealed[0] !== VERSION) {
    throw new Error('coach certificate: not a sealed file of this version');
  }
  const iv = sealed.subarray(1, 1 + IV_BYTES);
  const tag = sealed.subarray(1 + IV_BYTES, 1 + IV_BYTES + TAG_BYTES);
  const body = sealed.subarray(1 + IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', sealingKey(), iv, { authTagLength: TAG_BYTES });
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]);
}
