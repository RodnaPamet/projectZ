/**
 * What a coach's certificate may be (#545), as plain numbers: the form in the
 * browser reads these, and `certificate.ts` (which seals and opens the file,
 * and needs `node:crypto`) re-exports them, so the two cannot disagree and the
 * browser bundle carries no crypto.
 */

export const CERTIFICATE_MAX_BYTES = 5 * 1024 * 1024;

export const CERTIFICATE_TYPES = {
  'application/pdf': 'pdf',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
} as const;
export type CertificateMime = keyof typeof CERTIFICATE_TYPES;

/**
 * A file's size as a person reads it: megabytes to one decimal from 1 MB up,
 * whole kilobytes below (never 0). A 53 KB scan is not "0,0 MB".
 */
export function certificateSize(bytes: number): { value: number; unit: 'KB' | 'MB' } {
  const MB = 1024 * 1024;
  return bytes >= MB
    ? { value: Math.round((bytes / MB) * 10) / 10, unit: 'MB' }
    : { value: Math.max(1, Math.round(bytes / 1024)), unit: 'KB' };
}
