/**
 * @jest-environment node
 */
import { globSync, readFileSync } from 'node:fs';

import QRCode from 'qrcode';

import { otpauthUri } from '@/lib/auth/totp';
import { enrolmentQr, QUIET_ZONE } from '@/lib/auth/totp-qr';
import { createChildLogger, logger } from '@/lib/observability/logger';

import { captureLogs } from '../../helpers/capture-logs';

/**
 * The enrolment QR (#342): drawn on the server, from exactly the URI the
 * enrolment produced, and never in the browser.
 */

// A made-up fixture key; nothing anywhere is enrolled with it.
const SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP'; // pragma: allowlist secret
const URI = otpauthUri(SECRET, 'moderator.with.a.long.name@playerz.bg');

/** Reads the path back into a grid: `M{x} {y}h{run}v1h-{run}z` per run. */
function gridOf(path: string, size: number): boolean[][] {
  const grid = Array.from({ length: size }, () => Array<boolean>(size).fill(false));
  const runs = [...path.matchAll(/M(\d+) (\d+)h(\d+)v1h-(\d+)z/g)];
  // Nothing in the path but these runs: no stray commands to misdraw.
  expect(runs.map((r) => r[0]).join('')).toBe(path);
  for (const [, x, y, run, back] of runs) {
    expect(back).toBe(run);
    for (let i = 0; i < Number(run); i++) grid[Number(y)]![Number(x) + i] = true;
  }
  return grid;
}

describe('enrolmentQr', () => {
  it('draws exactly the modules of the QR code for the URI it was given', () => {
    const qr = enrolmentQr(URI);
    const { modules } = QRCode.create(URI, { errorCorrectionLevel: 'M' });
    expect(qr.size).toBe(modules.size + 2 * QUIET_ZONE);

    const grid = gridOf(qr.path, qr.size);
    for (let y = 0; y < modules.size; y++) {
      for (let x = 0; x < modules.size; x++) {
        expect([x, y, grid[y + QUIET_ZONE]![x + QUIET_ZONE]]).toEqual([
          x,
          y,
          modules.get(y, x) === 1,
        ]);
      }
    }
  });

  it('leaves a light quiet zone of four modules on every side', () => {
    const qr = enrolmentQr(URI);
    const grid = gridOf(qr.path, qr.size);
    const inQuietZone = (x: number, y: number) =>
      x < QUIET_ZONE || y < QUIET_ZONE || x >= qr.size - QUIET_ZONE || y >= qr.size - QUIET_ZONE;
    for (let y = 0; y < qr.size; y++) {
      for (let x = 0; x < qr.size; x++) if (inQuietZone(x, y)) expect(grid[y]![x]).toBe(false);
    }
    expect(QUIET_ZONE).toBe(4);
  });

  it('a different secret draws a different code', () => {
    const other = otpauthUri('KRUGS4ZANFZSAYJAORSXG5BAMNXWIZJA', 'x@playerz.bg'); // pragma: allowlist secret
    expect(enrolmentQr(other).path).not.toBe(enrolmentQr(URI).path);
  });
});

describe('the QR never reaches the browser bundle', () => {
  const sources = globSync('src/**/*.{ts,tsx}').map((f) => ({
    file: f.toString(),
    text: readFileSync(f, 'utf8'),
  }));

  it('only the server module imports `qrcode`', () => {
    const importers = sources
      .filter((s) => /from ['"]qrcode['"]|require\(['"]qrcode['"]\)/.test(s.text))
      .map((s) => s.file);
    expect(importers).toEqual(['src/lib/auth/totp-qr.ts']);
  });

  it('only the enrolment route imports the server module, and no client module does', () => {
    const importers = sources.filter((s) => /from ['"]@\/lib\/auth\/totp-qr['"]/.test(s.text));
    expect(importers.map((s) => s.file)).toEqual(['src/app/api/v1/me/mfa/enrolment/route.ts']);
    for (const s of importers) expect(s.text).not.toMatch(/^\s*['"]use client['"]/m);
  });
});

describe('logging', () => {
  it('the real logger redacts the QR, the URI and the seed', () => {
    const qr = enrolmentQr(URI);
    const { lines, restore } = captureLogs();
    try {
      logger.info('enrolment', { qr, otpauthUri: URI, secret: SECRET });
      createChildLogger({ component: 'mfa' }).info({ qr, otpauthUri: URI }, 'enrolment');
    } finally {
      restore();
    }

    const out = lines.join('');
    expect(lines).toHaveLength(2);
    expect(out).toContain('"qr":"[Redacted]"');
    expect(out).toContain('"otpauthUri":"[Redacted]"');
    expect(out).not.toContain(SECRET);
    expect(out).not.toContain(qr.path.slice(0, 40));
  });
});
