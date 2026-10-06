import { mkdtemp, readFile, rm, stat, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { crc32 } from 'node:zlib';

import type { Role } from '@prisma/client';
import { NextRequest } from 'next/server';
import sharp from 'sharp';

import { kindForRole } from '@/lib/auth/account-kind';
import { runInTenantContext } from '@/lib/db/rls-middleware';
import { LocalMediaStorage } from '@/lib/media/local';
import { getMediaStorage } from '@/lib/media/storage';

import { signInAs, type TestIdentity } from '../helpers/auth';
import { prismaTestClient, resetDatabase, seedTenant, type SeededTenant } from '../helpers/db';
import { asAppSuperuser } from '../helpers/rls';

/**
 * VENUE PHOTOS (#366), through the real upload route, the real actions and
 * the real v1 reads, against a real database and the LOCAL storage adapter in
 * a temporary directory.
 *
 * What matters most here is what is REFUSED: a file that is not a photo
 * whatever its name says, a decompression bomb, a member without
 * `admin.venue_manage`, and one club reaching for another's venue or photo.
 */

let signedInAs = '';
const NO_GATE_CLEARED = { groupGateCleared: [] as string[] };

jest.mock('next/cache', () => ({ revalidatePath: jest.fn(), revalidateTag: jest.fn() }));
jest.mock('@/lib/auth/page-context', () => {
  const actual = jest.requireActual('@/lib/auth/page-context');
  return {
    ...actual,
    requireTenantAction: async (slug: string, permission: string) => {
      const res = await actual.membershipContext(signedInAs, slug, NO_GATE_CLEARED);
      if (res.kind !== 'ok' || !res.ctx.permissions.includes(permission)) {
        throw new actual.TenantActionDeniedError(slug, permission);
      }
      return res.ctx;
    },
  };
});

import {
  deletePhotoAction,
  movePhotoAction,
  updatePhotoAltAction,
} from '@/app/(app)/t/[slug]/admin/photos/actions';
import { POST as sweepRoute } from '@/app/api/cron/sweep-orphan-media/route';
import { POST as uploadRoute } from '@/app/api/t/[slug]/admin/venues/[venueId]/photos/route';
import { GET as venueRoute } from '@/app/api/v1/venues/[id]/route';
import { GET as venuesRoute } from '@/app/api/v1/venues/route';
import { GET as mediaRoute } from '@/app/media/[...key]/route';

type PhotoJson = {
  id: string;
  alt: string;
  url: string;
  width: number;
  height: number;
  variants: { width: number; url: string }[];
  blurDataUrl: string | null;
};
type Json = { data?: PhotoJson & Record<string, unknown>; error?: { code: string } };

describe('venue photos (#366)', () => {
  const db = prismaTestClient();
  let dir: string;
  let club: SeededTenant;
  let other: SeededTenant;
  let owner: TestIdentity;
  let venueId: string;
  let otherVenueId: string;

  const saved = { ...process.env };

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), '366-media-'));
    process.env.MEDIA_STORAGE = 'local';
    process.env.MEDIA_LOCAL_DIR = dir;
    process.env.CRON_SECRET = 'test-cron-secret-366'; // pragma: allowlist secret -- a test-only value
    delete process.env.MEDIA_PUBLIC_BASE_URL;
  });

  afterAll(async () => {
    process.env = saved;
    await rm(dir, { recursive: true, force: true });
  });

  async function venueFor(tenantId: string, tag: string) {
    const v = await asAppSuperuser(db, (tx) =>
      tx.venue.create({
        data: {
          tenantId,
          name: `Site ${tag}`,
          slug: `site-${tag}-${tenantId.slice(-8)}`,
          addressLine: 'bul. Vitosha 1',
          city: 'Sofia',
          lat: 42.6977,
          lng: 23.3219,
          email: `site-${tag}-${tenantId.slice(-8)}@test.invalid`,
        },
        select: { id: true },
      }),
    );
    return v.id;
  }

  async function member(tenant: SeededTenant, role: Role): Promise<TestIdentity> {
    const user = await asAppSuperuser(db, (tx) =>
      tx.user.create({
        data: {
          email: `${role.toLowerCase()}-${Math.random().toString(36).slice(2, 8)}@test.invalid`,
          name: role,
          accountKind: kindForRole(role),
        },
        select: { id: true },
      }),
    );
    await asAppSuperuser(db, (tx) =>
      tx.tenantMembership.create({
        data: { tenantId: tenant.tenantId, userId: user.id, role, status: 'ACTIVE' },
      }),
    );
    return signInAs(db, {
      userId: user.id,
      memberships: [{ tenantId: tenant.tenantId, tenantSlug: tenant.tenantSlug, role }],
    });
  }

  beforeEach(async () => {
    await resetDatabase(db);
    await rm(dir, { recursive: true, force: true });
    club = await seedTenant({}, db);
    other = await seedTenant({}, db);
    owner = await signInAs(db, {
      userId: club.userId,
      memberships: [{ tenantId: club.tenantId, tenantSlug: club.tenantSlug, role: 'OWNER' }],
    });
    signedInAs = club.userId;
    venueId = await venueFor(club.tenantId, 'a');
    otherVenueId = await venueFor(other.tenantId, 'b');
  });

  // ─── fixtures ──────────────────────────────────────────────────────

  const solid = (width: number, height: number) =>
    sharp({ create: { width, height, channels: 3, background: { r: 30, g: 140, b: 90 } } });

  /** A JPEG carrying an author and a GPS position in its EXIF. */
  const jpegWithGps = () =>
    solid(2400, 1600)
      .jpeg()
      .withExif({
        IFD0: { Artist: 'Secret Photographer 366', Copyright: 'Owner 366' },
        IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '42/1 41/1 0/1' },
      })
      .toBuffer();

  /** A small valid PNG whose IHDR is rewritten to declare `w` × `h` pixels. */
  async function pngBomb(w: number, h: number): Promise<Buffer> {
    const png = Buffer.from(await solid(10, 10).png().toBuffer());
    // IHDR: length(4) "IHDR"(4) width(4) height(4) ... CRC over type+data (17 bytes).
    png.writeUInt32BE(w, 16);
    png.writeUInt32BE(h, 20);
    png.writeUInt32BE(crc32(png.subarray(12, 29)) >>> 0, 29);
    return png;
  }

  function upload(
    file: Buffer | string,
    opts: {
      who?: TestIdentity;
      slug?: string;
      venue?: string;
      alt?: string | null;
      kind?: 'cover' | 'gallery';
      name?: string;
      type?: string;
    } = {},
  ) {
    const form = new FormData();
    const body = typeof file === 'string' ? Buffer.from(file) : file;
    form.set(
      'file',
      new Blob([new Uint8Array(body)], { type: opts.type ?? 'image/jpeg' }),
      opts.name ?? 'photo.jpg',
    );
    if (opts.alt !== null) form.set('alt', opts.alt ?? 'Корт 1 отвън, вечер');
    form.set('kind', opts.kind ?? 'gallery');
    const slug = opts.slug ?? club.tenantSlug;
    const venue = opts.venue ?? venueId;
    return uploadRoute(
      new NextRequest(`http://t/api/t/${slug}/admin/venues/${venue}/photos`, {
        method: 'POST',
        headers: { authorization: `Bearer ${(opts.who ?? owner).bearer}` },
        body: form,
      }),
      { params: Promise.resolve({ slug, venueId: venue }) },
    );
  }

  const read = async (res: Response) => ({ status: res.status, body: (await res.json()) as Json });

  const keyOf = (url: string) => url.replace(/^.*\/media\//, '');
  const fileOf = (url: string) => path.join(dir, keyOf(url));
  const exists = (p: string) =>
    stat(p).then(
      () => true,
      () => false,
    );

  const audits = (tenantId: string) =>
    asAppSuperuser(db, (tx) =>
      tx.auditEntry.findMany({
        where: { tenantId, entity: 'VenuePhoto' },
        orderBy: { createdAt: 'asc' },
        select: { action: true, actorUserId: true, entityId: true },
      }),
    );

  // ─── uploads that work ─────────────────────────────────────────────

  it('THE POINT: a JPEG becomes WebP renditions at 640/1280/1920, EXIF and GPS gone, audited', async () => {
    const { status, body } = await read(await upload(await jpegWithGps()));
    expect(status).toBe(201);
    const photo = body.data!;
    expect(photo.variants.map((v) => v.width)).toEqual([640, 1280, 1920]);
    expect(photo.url).toBe(photo.variants[1]!.url);
    expect(photo.url).toMatch(
      new RegExp(`^http://localhost:3000/media/venues/${venueId}/[0-9a-f-]{36}-1280\\.webp$`),
    );
    expect(photo).toMatchObject({ alt: 'Корт 1 отвън, вечер', width: 1920, height: 1280 });
    expect(photo.blurDataUrl).toMatch(/^data:image\/webp;base64,/);

    for (const v of photo.variants) {
      const bytes = await readFile(fileOf(v.url));
      const meta = await sharp(bytes).metadata();
      expect(meta.format).toBe('webp');
      expect(meta.width).toBe(v.width);
      expect(meta.exif).toBeUndefined();
      expect(meta.xmp).toBeUndefined();
      expect(bytes.includes(Buffer.from('Secret Photographer'))).toBe(false);
    }

    expect(await audits(club.tenantId)).toEqual([
      { action: 'VENUE_PHOTO_ADDED', actorUserId: club.userId, entityId: photo.id },
    ]);
  });

  it('a PNG narrower than 1280 gets 640 and its own width, never upscaled', async () => {
    const { status, body } = await read(
      await upload(await solid(800, 600).png().toBuffer(), { type: 'image/png', name: 'a.png' }),
    );
    expect(status).toBe(201);
    expect(body.data!.variants.map((v) => v.width)).toEqual([640, 800]);
  });

  it('a WebP smaller than 640 is kept at its own width', async () => {
    const { status, body } = await read(
      await upload(await solid(300, 300).webp().toBuffer(), { type: 'image/webp' }),
    );
    expect(status).toBe(201);
    expect(body.data!.variants.map((v) => v.width)).toEqual([300]);
  });

  it('the format is read from the bytes: a PNG named .gif with a lying type still works', async () => {
    const png = await solid(400, 400).png().toBuffer();
    const res = await upload(png, { name: 'x.gif', type: 'text/plain' });
    expect(res.status).toBe(201);
  });

  // ─── uploads that are refused ──────────────────────────────────────

  it.each([
    [
      'an SVG',
      '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400"><script>alert(1)</script></svg>',
      'image/svg+xml',
    ],
    [
      'HTML named photo.jpg',
      '<!doctype html><html><body><script>alert(1)</script></body></html>',
      'image/jpeg',
    ],
    ['a GIF', 'GIF89a' + '\0'.repeat(64), 'image/gif'],
  ])('refuses %s: 415 UNSUPPORTED_TYPE, nothing stored', async (_label, content, type) => {
    const { status, body } = await read(await upload(content, { type }));
    expect(status).toBe(415);
    expect(body.error?.code).toBe('UNSUPPORTED_TYPE');
    expect(await exists(path.join(dir, 'venues'))).toBe(false);
  });

  it('refuses a JPEG header glued to HTML (a polyglot that does not decode)', async () => {
    const fake = Buffer.concat([
      Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
      Buffer.from('<html><script>alert(1)</script></html>'.repeat(10)),
    ]);
    const { status, body } = await read(await upload(fake));
    expect(status).toBe(422);
    expect(body.error?.code).toBe('UNREADABLE');
  });

  it('refuses a file over 8 MB: 413 TOO_LARGE', async () => {
    const big = Buffer.alloc(9 * 1024 * 1024, 0);
    big.set([0xff, 0xd8, 0xff], 0);
    const { status, body } = await read(await upload(big));
    expect(status).toBe(413);
    expect(body.error?.code).toBe('TOO_LARGE');
  });

  it('refuses a decompression bomb from its header, before decoding: 413 TOO_MANY_PIXELS', async () => {
    const { status, body } = await read(
      await upload(await pngBomb(40_000, 40_000), { type: 'image/png' }),
    );
    expect(status).toBe(413);
    expect(body.error?.code).toBe('TOO_MANY_PIXELS');
  });

  it('refuses a photo too small to use: 422 TOO_SMALL', async () => {
    const { status, body } = await read(await upload(await solid(120, 120).jpeg().toBuffer()));
    expect(status).toBe(422);
    expect(body.error?.code).toBe('TOO_SMALL');
  });

  it('alt text is required, and markup in it is kept as text', async () => {
    const missing = await read(
      await upload(await solid(400, 400).jpeg().toBuffer(), { alt: '   ' }),
    );
    expect(missing.status).toBe(400);
    expect(missing.body.error?.code).toBe('ALT_REQUIRED');

    const odd = '<img src=x onerror=alert(1)>\u0000 "корт"';
    const ok = await read(await upload(await solid(400, 400).jpeg().toBuffer(), { alt: odd }));
    expect(ok.status).toBe(201);
    expect(ok.body.data!.alt).toBe('<img src=x onerror=alert(1)> "корт"');
  });

  // ─── who may ───────────────────────────────────────────────────────

  it.each(['STAFF', 'COACH', 'PLAYER'] as const)(
    'a %s member is refused with 403 before the body is read',
    async (role) => {
      const who = await member(club, role);
      const { status, body } = await read(
        await upload(await solid(400, 400).jpeg().toBuffer(), { who }),
      );
      expect(status).toBe(403);
      expect(body.error?.code).toBe('FORBIDDEN');
      expect(await audits(club.tenantId)).toHaveLength(0);
    },
  );

  it('a MANAGER may upload', async () => {
    const who = await member(club, 'MANAGER');
    const res = await upload(await solid(400, 400).jpeg().toBuffer(), { who });
    expect(res.status).toBe(201);
  });

  it('IDOR: an owner cannot put a photo on another club’s venue, by either slug', async () => {
    const jpeg = await solid(400, 400).jpeg().toBuffer();
    const viaOwnSlug = await read(await upload(jpeg, { venue: otherVenueId }));
    expect(viaOwnSlug.status).toBe(404);
    expect(viaOwnSlug.body.error?.code).toBe('VENUE_NOT_FOUND');

    const viaTheirSlug = await upload(jpeg, { slug: other.tenantSlug, venue: otherVenueId });
    expect([403, 404]).toContain(viaTheirSlug.status);

    const rows = await asAppSuperuser(db, (tx) => tx.venuePhoto.count());
    expect(rows).toBe(0);
    expect(await exists(path.join(dir, 'venues', otherVenueId))).toBe(false);
  });

  it('the database refuses a photo row whose venue belongs to another club', async () => {
    await expect(
      runInTenantContext(club.tenantId, (tx) =>
        tx.venuePhoto.create({
          data: { tenantId: club.tenantId, venueId: otherVenueId, url: 'https://x.invalid/a.webp' },
        }),
      ),
    ).rejects.toThrow();
  });

  it('RLS: another club sees none of this club’s photo rows', async () => {
    await upload(await solid(400, 400).jpeg().toBuffer());
    const seen = await runInTenantContext(other.tenantId, (tx) =>
      tx.venuePhoto.findMany({ take: 5 }),
    );
    expect(seen).toHaveLength(0);
    const own = await runInTenantContext(club.tenantId, (tx) =>
      tx.venuePhoto.findMany({ take: 5 }),
    );
    expect(own).toHaveLength(1);
  });

  // ─── cover, order, alt, removal ────────────────────────────────────

  it('a new cover replaces the old one and deletes its objects', async () => {
    const first = (
      await read(await upload(await solid(700, 400).jpeg().toBuffer(), { kind: 'cover' }))
    ).body.data!;
    const second = (
      await read(await upload(await solid(900, 500).jpeg().toBuffer(), { kind: 'cover' }))
    ).body.data!;

    for (const v of first.variants) expect(await exists(fileOf(v.url))).toBe(false);
    for (const v of second.variants) expect(await exists(fileOf(v.url))).toBe(true);

    const covers = await asAppSuperuser(db, (tx) =>
      tx.venuePhoto.findMany({ where: { venueId, kind: 'COVER' }, select: { id: true } }),
    );
    expect(covers).toEqual([{ id: second.id }]);
    const venue = await asAppSuperuser(db, (tx) =>
      tx.venue.findUniqueOrThrow({ where: { id: venueId }, select: { coverPhotoUrl: true } }),
    );
    expect(venue.coverPhotoUrl).toBe(second.url);
  });

  it('the gallery is capped at 12', async () => {
    await asAppSuperuser(db, (tx) =>
      tx.venuePhoto.createMany({
        data: Array.from({ length: 12 }, (_, i) => ({
          tenantId: club.tenantId,
          venueId,
          url: `https://x.invalid/${i}.webp`,
          alt: `photo ${i}`,
          position: i,
        })),
      }),
    );
    const { status, body } = await read(await upload(await solid(400, 400).jpeg().toBuffer()));
    expect(status).toBe(409);
    expect(body.error?.code).toBe('GALLERY_FULL');
  });

  it('reorders, edits alt text and deletes through the actions, objects and all, audited', async () => {
    const a = (await read(await upload(await solid(400, 400).jpeg().toBuffer(), { alt: 'A' }))).body
      .data!;
    const b = (await read(await upload(await solid(400, 400).jpeg().toBuffer(), { alt: 'B' }))).body
      .data!;

    await expect(movePhotoAction(club.tenantSlug, b.id, 'up')).resolves.toEqual({ ok: true });
    const order = await asAppSuperuser(db, (tx) =>
      tx.venuePhoto.findMany({
        where: { venueId },
        orderBy: { position: 'asc' },
        select: { id: true },
      }),
    );
    expect(order.map((o) => o.id)).toEqual([b.id, a.id]);

    const form = new FormData();
    form.set('alt', 'Корт 2 отвътре');
    await expect(updatePhotoAltAction(club.tenantSlug, a.id, null, form)).resolves.toEqual({
      ok: true,
    });

    await expect(deletePhotoAction(club.tenantSlug, a.id)).resolves.toEqual({ ok: true });
    for (const v of a.variants) expect(await exists(fileOf(v.url))).toBe(false);
    for (const v of b.variants) expect(await exists(fileOf(v.url))).toBe(true);

    expect((await audits(club.tenantId)).map((r) => r.action)).toEqual([
      'VENUE_PHOTO_ADDED',
      'VENUE_PHOTO_ADDED',
      'VENUE_PHOTO_MOVED',
      'VENUE_PHOTO_ALT_CHANGED',
      'VENUE_PHOTO_DELETED',
    ]);
  });

  it('the actions refuse STAFF, and treat another club’s photo as not found', async () => {
    const theirs = await asAppSuperuser(db, (tx) =>
      tx.venuePhoto.create({
        data: { tenantId: other.tenantId, venueId: otherVenueId, url: 'https://x.invalid/t.webp' },
        select: { id: true },
      }),
    );
    await expect(deletePhotoAction(club.tenantSlug, theirs.id)).resolves.toEqual({
      ok: false,
      error: 'PHOTO_NOT_FOUND',
    });
    expect(await asAppSuperuser(db, (tx) => tx.venuePhoto.count())).toBe(1);

    const staff = await member(club, 'STAFF');
    signedInAs = staff.userId;
    await expect(deletePhotoAction(club.tenantSlug, theirs.id)).rejects.toThrow();
    const form = new FormData();
    form.set('alt', 'x');
    await expect(updatePhotoAltAction(club.tenantSlug, theirs.id, null, form)).rejects.toThrow();
  });

  // ─── reads ─────────────────────────────────────────────────────────

  it('the v1 venue detail and list carry the cover and gallery with every width and the alt', async () => {
    const cover = (
      await read(
        await upload(await solid(2000, 1000).jpeg().toBuffer(), { kind: 'cover', alt: 'Корица' }),
      )
    ).body.data!;
    const g = (await read(await upload(await solid(800, 800).png().toBuffer(), { alt: 'Галерия' })))
      .body.data!;

    const detail = (await (
      await venueRoute(new NextRequest(`http://t/api/v1/venues/${venueId}`), {
        params: Promise.resolve({ id: venueId }),
      })
    ).json()) as { data: Record<string, unknown> };
    expect(detail.data.cover).toEqual(cover);
    expect(detail.data.coverPhotoUrl).toBe(cover.url);
    expect(detail.data.photos).toEqual([g]);

    const list = (await (
      await venuesRoute(new NextRequest('http://t/api/v1/venues'), {})
    ).json()) as {
      data: { items: Array<Record<string, unknown>> };
    };
    const card = list.data.items.find((i) => i.id === venueId)!;
    expect(card.cover).toEqual(cover);
    expect(card).not.toHaveProperty('photos');
  });

  it('the local /media route serves a rendition, and nothing outside the pattern', async () => {
    const photo = (await read(await upload(await solid(400, 400).jpeg().toBuffer()))).body.data!;
    const key = keyOf(photo.url);
    const ok = await mediaRoute(new NextRequest(`http://t/media/${key}`), {
      params: Promise.resolve({ key: key.split('/') }),
    });
    expect(ok.status).toBe(200);
    expect(ok.headers.get('content-type')).toBe('image/webp');
    expect(ok.headers.get('cache-control')).toContain('immutable');

    for (const parts of [
      ['..', '..', 'etc', 'passwd'],
      ['venues', venueId, '..', '..', '.env'],
      ['venues', venueId, 'not-a-key.webp'],
    ]) {
      const res = await mediaRoute(new NextRequest('http://t/media/x'), {
        params: Promise.resolve({ key: parts }),
      });
      expect(res.status).toBe(404);
    }
  });

  it('the sweep deletes day-old objects no row names, and keeps the rest', async () => {
    const kept = (await read(await upload(await solid(400, 400).jpeg().toBuffer()))).body.data!;
    const gone = (await read(await upload(await solid(400, 400).jpeg().toBuffer()))).body.data!;
    const fresh = (await read(await upload(await solid(400, 400).jpeg().toBuffer()))).body.data!;
    // `gone` and `fresh` lose their rows (a venue removal cascading, say)
    // without their objects being deleted; only `gone` is a day old.
    await asAppSuperuser(db, (tx) =>
      tx.venuePhoto.deleteMany({ where: { id: { in: [gone.id, fresh.id] } } }),
    );
    const old = new Date(Date.now() - 2 * 24 * 3600 * 1000);
    for (const v of [...kept.variants, ...gone.variants]) await utimes(fileOf(v.url), old, old);

    const res = await sweepRoute(
      new NextRequest('http://t/api/cron/sweep-orphan-media', {
        method: 'POST',
        headers: { 'x-cron-secret': 'test-cron-secret-366' },
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ deleted: gone.variants.length, truncated: false });
    for (const v of gone.variants) expect(await exists(fileOf(v.url))).toBe(false);
    for (const v of [...kept.variants, ...fresh.variants])
      expect(await exists(fileOf(v.url))).toBe(true);

    const refused = await sweepRoute(
      new NextRequest('http://t/api/cron/sweep-orphan-media', { method: 'POST' }),
    );
    expect(refused.status).toBe(401);
  });

  it('with no storage configured, an upload is 503 MEDIA_NOT_CONFIGURED', async () => {
    delete process.env.MEDIA_STORAGE;
    try {
      expect(getMediaStorage()).toBeNull();
      const { status, body } = await read(await upload(await solid(400, 400).jpeg().toBuffer()));
      expect(status).toBe(503);
      expect(body.error?.code).toBe('MEDIA_NOT_CONFIGURED');
    } finally {
      process.env.MEDIA_STORAGE = 'local';
    }
    expect(getMediaStorage()).toBeInstanceOf(LocalMediaStorage);
  });
});
