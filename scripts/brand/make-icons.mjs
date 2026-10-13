#!/usr/bin/env node
/**
 * The app's icons and its default share image, from one lettermark (#432).
 *
 * The owner has no logo yet (2026-10-13), so this draws a placeholder in the
 * dark palette (src/styles/tokens.css): a violet "p" whose bowl holds a yellow
 * ball, on midnight black. When the real logo arrives, replace `mark()` with
 * it and run this again:
 *
 *   node scripts/brand/make-icons.mjs
 *
 * It writes:
 *   public/icons/icon-192.png, icon-512.png    the manifest's "any" icons
 *   public/icons/icon-maskable-512.png         full bleed, the mark in the 80% safe zone
 *   src/app/icon.svg                           the browser tab icon
 *   src/app/favicon.ico                        16, 32 and 48 px, for clients that only ask for /favicon.ico
 *   src/app/apple-icon.png                     180 px, square (iOS rounds it)
 *   src/app/opengraph-image.png                1200×630, the default link preview
 *
 * The share image's text is rendered by librsvg with a system sans-serif, so
 * a run on another machine can differ by a pixel or two. The PNGs are
 * committed; nothing renders them at request time.
 */
import { mkdirSync, writeFileSync } from 'node:fs';

import sharp from 'sharp';

const MIDNIGHT = '#0b0b12';
const VIOLET = '#7950f5';
const VIOLET_DEEP = '#6d3fe8';
const YELLOW = '#facc15';

/** The lettermark on a 512 grid, without a background. */
function mark() {
  return `
    <rect x="132" y="150" width="76" height="262" rx="38" fill="${VIOLET_DEEP}"/>
    <circle cx="282" cy="236" r="112" fill="none" stroke="${VIOLET}" stroke-width="76"/>
    <circle cx="282" cy="236" r="40" fill="${YELLOW}"/>`;
}

/** The mark on a background. `inset` scales it into the middle (maskable). */
function iconSvg({ rounded, inset = 1 }) {
  const r = rounded ? 112 : 0;
  const t = (512 * (1 - inset)) / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <rect width="512" height="512" rx="${r}" fill="${MIDNIGHT}"/>
  <g transform="translate(${t} ${t}) scale(${inset})">${mark()}</g>
</svg>
`;
}

async function png(svg, size) {
  return sharp(Buffer.from(svg)).resize(size, size).png({ compressionLevel: 9 }).toBuffer();
}

/** A .ico of PNG entries (Vista+ format: the PNG bytes go in as they are). */
function ico(entries) {
  const header = Buffer.alloc(6 + 16 * entries.length);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(entries.length, 4);
  let offset = header.length;
  entries.forEach(({ size, data }, i) => {
    const at = 6 + 16 * i;
    header.writeUInt8(size >= 256 ? 0 : size, at);
    header.writeUInt8(size >= 256 ? 0 : size, at + 1);
    header.writeUInt8(0, at + 2);
    header.writeUInt8(0, at + 3);
    header.writeUInt16LE(1, at + 4);
    header.writeUInt16LE(32, at + 6);
    header.writeUInt32LE(data.length, at + 8);
    header.writeUInt32LE(offset, at + 12);
    offset += data.length;
  });
  return Buffer.concat([header, ...entries.map((e) => e.data)]);
}

function shareSvg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 630" width="1200" height="630">
  <rect width="1200" height="630" fill="${MIDNIGHT}"/>
  <g transform="translate(96 167) scale(0.578)">${mark()}</g>
  <text x="430" y="300" font-family="Helvetica, Arial, sans-serif" font-weight="700" font-size="104" fill="#ffffff">playerz<tspan fill="${YELLOW}">.bg</tspan></text>
  <text x="434" y="380" font-family="Helvetica, Arial, sans-serif" font-size="40" fill="#c4b5fd">Намери корт. Резервирай за секунди.</text>
  <rect x="434" y="420" width="120" height="8" rx="4" fill="${YELLOW}"/>
</svg>
`;
}

mkdirSync('public/icons', { recursive: true });

const rounded = iconSvg({ rounded: true });
const square = iconSvg({ rounded: false });
const maskable = iconSvg({ rounded: false, inset: 0.72 });

writeFileSync('public/icons/icon-192.png', await png(rounded, 192));
writeFileSync('public/icons/icon-512.png', await png(rounded, 512));
writeFileSync('public/icons/icon-maskable-512.png', await png(maskable, 512));
writeFileSync('src/app/icon.svg', rounded);
writeFileSync('src/app/apple-icon.png', await png(square, 180));
writeFileSync(
  'src/app/favicon.ico',
  ico(
    await Promise.all([16, 32, 48].map(async (size) => ({ size, data: await png(rounded, size) }))),
  ),
);
writeFileSync(
  'src/app/opengraph-image.png',
  await sharp(Buffer.from(shareSvg())).png({ compressionLevel: 9 }).toBuffer(),
);

console.log('icons written');
