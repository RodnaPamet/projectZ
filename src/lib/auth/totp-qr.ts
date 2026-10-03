import QRCode from 'qrcode';

/**
 * The enrolment QR code, drawn on the SERVER (#342).
 *
 * The `otpauth://` URI carries the TOTP seed, so where it is turned into a
 * picture matters:
 *
 *   • Never a third-party QR service. The seed would leave in a URL.
 *   • Not in the browser either. `qrcode` would ship to every visitor of the
 *     page as client JS (and with it the bundle budget), only to encode a
 *     string the server already holds.
 *
 * So `POST /api/v1/me/mfa/enrolment` calls this beside `startEnrolment` and
 * returns the result in the same `no-store` response. What it returns is
 * plain SVG geometry: the side of the square in modules and one `d` path of
 * the dark modules. The page draws it with an ordinary `<svg>`; nothing is
 * injected as HTML and no QR code runs on the client.
 *
 * The geometry encodes the seed exactly as the URI does, so it is redacted
 * from logs like the URI (`qr` in `REDACT_PATHS`) and never cached.
 */

/** Light modules around the code. The spec asks for four; scanners need them. */
export const QUIET_ZONE = 4;

export interface EnrolmentQr {
  /** Side of the square in modules, quiet zone included: the SVG viewBox. */
  size: number;
  /** One SVG path of every dark module, in module units. */
  path: string;
}

/**
 * `uri` → the modules of its QR code as one SVG path.
 *
 * Error correction M: an otpauth URI with a long email still fits version 8
 * (49 modules), small enough to scan off a laptop screen at arm's length.
 * Adjacent dark modules in a row are merged into one rectangle, which keeps
 * the path about a third of the naive size.
 */
export function enrolmentQr(uri: string): EnrolmentQr {
  const { modules } = QRCode.create(uri, { errorCorrectionLevel: 'M' });
  const n = modules.size;
  const parts: string[] = [];

  for (let y = 0; y < n; y++) {
    let x = 0;
    while (x < n) {
      if (!modules.get(y, x)) {
        x++;
        continue;
      }
      const start = x;
      while (x < n && modules.get(y, x)) x++;
      const run = x - start;
      parts.push(`M${start + QUIET_ZONE} ${y + QUIET_ZONE}h${run}v1h-${run}z`);
    }
  }

  return { size: n + QUIET_ZONE * 2, path: parts.join('') };
}
