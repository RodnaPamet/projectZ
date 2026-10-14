import { NextRequest } from 'next/server';

import { GET as coachGet } from '@/app/api/v1/coaches/[slug]/route';
import { GET as coachesGet } from '@/app/api/v1/coaches/route';
import { GET as venueCoachesGet } from '@/app/api/v1/venues/[id]/coaches/route';
import { deleteAccount } from '@/app-layer/usecases/account-deletion';
import { listSitemapCoaches } from '@/app-layer/usecases/coach-directory';
import { runAsSuperuser } from '@/lib/db/rls-middleware';
import { clearAllRateLimits } from '@/lib/security/rate-limit';

import {
  prismaTestClient,
  resetDatabase,
  seedAccount,
  seedTenant,
  seedVenue,
  type SeededTenant,
} from '../helpers/db';
import { asAppSuperuser } from '../helpers/rls';

/**
 * FINDING A COACH (#547), through the public routes and a real database.
 *
 * What matters is who is NOT listed: a coach is shown to players only when
 * the platform approved them AND a lesson can actually be booked with them
 * somewhere that is open. And what is not shown: nothing but what the
 * platform approved for publication.
 */

const db = prismaTestClient();

type Json = { data?: unknown; error?: { code: string; details?: unknown } };
type Route = (req: NextRequest, ctx: never) => Promise<Response>;

async function call(route: unknown, url: string, params?: Record<string, string>) {
  // No Authorization header anywhere in this file: these are public reads.
  const req = new NextRequest(`http://t${url}`);
  const res = await (route as Route)(req, { params: Promise.resolve(params ?? {}) } as never);
  return { status: res.status, json: (await res.json()) as Json };
}

interface CoachDto {
  slug: string;
  name: string | null;
  avatarUrl: string | null;
  bio: string | null;
  qualifications: string | null;
  sports: Array<{ sport: string; levelMin: number; levelMax: number }>;
  fromRateCents: number | null;
  currency: string;
  venues: Array<{
    linkId: string;
    venueId: string;
    name: string;
    city: string;
    club: { name: string; slug: string };
    hourlyRateCents: number;
    groupRateCents: number | null;
    lessonMinutes: number[];
  }>;
}
const list = async (query = '') => {
  const r = await call(coachesGet, `/api/v1/coaches${query}`);
  return { ...r, page: r.json.data as { items: CoachDto[]; nextCursor: string | null } };
};
const one = async (slug: string) => {
  const r = await call(coachGet, `/api/v1/coaches/${slug}`, { slug });
  return { ...r, coach: r.json.data as CoachDto };
};
const atVenue = async (id: string) => {
  const r = await call(venueCoachesGet, `/api/v1/venues/${id}/coaches`, { id });
  return { ...r, items: (r.json.data as { items: CoachDto[] } | undefined)?.items ?? [] };
};

let club: SeededTenant;
let other: SeededTenant;
let venue: { venueId: string };
let venue2: { venueId: string };
let venueOther: { venueId: string };
let admin: string;

type Status = 'DRAFT' | 'SUBMITTED' | 'APPROVED' | 'DECLINED';

/** A coach account with a profile in `status`, sports as given. */
async function coach(
  slug: string,
  name: string,
  opts: { status?: Status; sports?: string[] } = {},
): Promise<string> {
  const userId = await seedAccount('COACH', db);
  const status = opts.status ?? 'APPROVED';
  const decided = status === 'APPROVED' || status === 'DECLINED';
  await asAppSuperuser(db, async (tx) => {
    await tx.user.update({ where: { id: userId }, data: { name } });
    await tx.$executeRawUnsafe(`SELECT set_config('app.platform_admin_id', $1, true)`, admin);
    await tx.coachProfile.create({
      data: {
        userId,
        slug,
        bio: `Представяне на ${name}.`,
        qualifications: 'Лиценз ББФТ',
        status,
        ...(decided ? { decidedAt: new Date(), decidedByUserId: admin } : {}),
        sports: {
          create: (opts.sports ?? ['PADEL']).map((sport) => ({
            sport: sport as never,
            levelMin: 1,
            levelMax: 5,
          })),
        },
      },
    });
  });
  return userId;
}

/** A link at a venue; by default one a lesson can be booked on. */
async function teaches(
  userId: string,
  at: { tenantId: string; venueId: string },
  over: {
    status?: 'REQUESTED' | 'ACTIVE' | 'ENDED';
    hourlyRateCents?: number | null;
    groupRateCents?: number | null;
    lessonMinutes?: number[];
    hours?: boolean;
  } = {},
): Promise<string> {
  return asAppSuperuser(db, async (tx) => {
    const link = await tx.coach.create({
      data: {
        tenantId: at.tenantId,
        venueId: at.venueId,
        userId,
        status: over.status ?? 'ACTIVE',
        startedBy: 'COACH',
        hourlyRateCents: over.hourlyRateCents === undefined ? 4000 : over.hourlyRateCents,
        groupRateCents: over.groupRateCents ?? null,
        lessonMinutes: over.lessonMinutes ?? [60, 90],
      },
      select: { id: true },
    });
    if (over.hours !== false) {
      await tx.coachAvailability.create({
        data: {
          tenantId: at.tenantId,
          coachId: link.id,
          dayOfWeek: 1,
          openTime: new Date('1970-01-01T09:00:00Z'),
          closeTime: new Date('1970-01-01T12:00:00Z'),
        },
      });
    }
    return link.id;
  });
}

const A = () => ({ tenantId: club.tenantId, venueId: venue.venueId });
const A2 = () => ({ tenantId: club.tenantId, venueId: venue2.venueId });
const B = () => ({ tenantId: other.tenantId, venueId: venueOther.venueId });

beforeEach(async () => {
  await resetDatabase(db);
  await clearAllRateLimits();
  club = await seedTenant({ name: 'Клуб Алфа' }, db);
  other = await seedTenant({ name: 'Клуб Бета' }, db);
  venue = await seedVenue(club.tenantId, { name: 'Алфа Кортове' }, db);
  venue2 = await seedVenue(club.tenantId, { name: 'Алфа Зала' }, db);
  venueOther = await seedVenue(other.tenantId, { name: 'Бета Арена' }, db);
  admin = await seedAccount('PLAYER', db);
});

describe('who is listed', () => {
  it('an approved coach with a bookable link, and exactly what the platform approved', async () => {
    const id = await coach('ivan-petrov', 'Иван Петров', { sports: ['TENNIS', 'PADEL'] });
    const linkId = await teaches(id, A(), { groupRateCents: 6000 });

    const { status, page } = await list();
    expect(status).toBe(200);
    expect(page).toEqual({
      nextCursor: null,
      items: [
        {
          slug: 'ivan-petrov',
          name: 'Иван Петров',
          avatarUrl: null,
          bio: 'Представяне на Иван Петров.',
          qualifications: 'Лиценз ББФТ',
          sports: [
            { sport: 'TENNIS', levelMin: 1, levelMax: 5 },
            { sport: 'PADEL', levelMin: 1, levelMax: 5 },
          ],
          fromRateCents: 4000,
          currency: 'EUR',
          venues: [
            {
              linkId,
              venueId: venue.venueId,
              name: 'Алфа Кортове',
              city: 'Sofia',
              publicSlug: expect.any(String),
              timezone: 'Europe/Sofia',
              club: { name: 'Клуб Алфа', slug: club.tenantSlug },
              // They teach tennis too, and this venue has no tennis court.
              sports: ['PADEL'],
              hourlyRateCents: 4000,
              groupRateCents: 6000,
              currency: 'EUR',
              lessonMinutes: [60, 90],
            },
          ],
        },
      ],
    });
    // The account id is not given out, nor an address, a phone, or anything of a certificate.
    const text = JSON.stringify(page);
    expect(text).not.toContain(id);
    expect(text).not.toMatch(/@playerz\.test|email|phone|certificate|userId/i);
  });

  it.each([
    ['no rate yet', { hourlyRateCents: null }],
    ['no lesson length', { lessonMinutes: [] }],
    ['no weekly hours', { hours: false }],
    ['a request the club has not answered', { status: 'REQUESTED' as const }],
    ['a link that was ended', { status: 'ENDED' as const }],
  ])('not with %s: nobody could book them', async (_l, over) => {
    const id = await coach('ivan-petrov', 'Иван Петров');
    await teaches(id, A(), over);
    expect((await list()).page.items).toEqual([]);
    expect((await atVenue(venue.venueId)).items).toEqual([]);
    // Approved, so the page is there; it says they teach nowhere.
    const page = await one('ivan-petrov');
    expect(page.status).toBe(200);
    expect(page.coach).toMatchObject({ venues: [], fromRateCents: null });
  });

  it('not at a venue with no court in use for a sport they teach: nothing there could be booked', async () => {
    // Venue A has one padel court. A tennis coach has a link there, with a
    // rate, lengths and hours: ready in every way but one.
    const id = await coach('ivan-petrov', 'Иван Петров', { sports: ['TENNIS'] });
    await teaches(id, A());
    expect((await list()).page.items).toEqual([]);
    expect((await atVenue(venue.venueId)).items).toEqual([]);
    expect((await one('ivan-petrov')).coach.venues).toEqual([]);

    // A tennis court that is not in use changes nothing; one in use lists them.
    const court = await asAppSuperuser(db, (tx) =>
      tx.resource.create({
        data: {
          tenantId: club.tenantId,
          venueId: venue.venueId,
          name: 'Tennis 1',
          sport: 'TENNIS',
          surface: 'CLAY',
          basePriceCents: 2000,
          status: 'CLOSED',
        },
      }),
    );
    expect((await list()).page.items).toEqual([]);
    await asAppSuperuser(db, (tx) =>
      tx.resource.update({ where: { id: court.id }, data: { status: 'ACTIVE' } }),
    );
    expect((await list()).page.items.map((c) => c.slug)).toEqual(['ivan-petrov']);
    expect((await atVenue(venue.venueId)).items.map((c) => c.slug)).toEqual(['ivan-petrov']);
  });

  it.each([['DRAFT'], ['SUBMITTED'], ['DECLINED']] as const)(
    'not a coach whose profile is %s, even with a link a club gave them, and they have no page',
    async (status) => {
      const id = await coach('nov-trenyor', 'Нов Треньор', { status });
      await teaches(id, A());
      expect((await list()).page.items).toEqual([]);
      expect((await atVenue(venue.venueId)).items).toEqual([]);
      const page = await one('nov-trenyor');
      expect(page.status).toBe(404);
      expect(page.json.error?.code).toBe('NOT_FOUND');
    },
  );

  it('not at a venue that is closed, or of a club that is not open', async () => {
    const id = await coach('ivan-petrov', 'Иван Петров');
    await teaches(id, A(), { hourlyRateCents: 5000 });
    await teaches(id, B(), { hourlyRateCents: 3000 });
    expect((await list()).page.items[0]!.venues.map((v) => v.name)).toEqual([
      'Бета Арена',
      'Алфа Кортове',
    ]);

    await asAppSuperuser(db, (tx) =>
      tx.venueOrg.update({ where: { id: other.tenantId }, data: { status: 'SUSPENDED' } }),
    );
    // The suspended club's venue is gone from the coach, and the price from follows.
    const afterClub = (await list()).page.items[0]!;
    expect(afterClub.venues.map((v) => v.name)).toEqual(['Алфа Кортове']);
    expect(afterClub.fromRateCents).toBe(5000);
    expect((await atVenue(venueOther.venueId)).items).toEqual([]);

    await asAppSuperuser(db, (tx) =>
      tx.venue.update({ where: { id: venue.venueId }, data: { status: 'CLOSED' } }),
    );
    expect((await list()).page.items).toEqual([]);
    expect((await one('ivan-petrov')).coach.venues).toEqual([]);
  });

  it('not an account that is gone: no list, no page, no venue', async () => {
    const id = await coach('ivan-petrov', 'Иван Петров');
    await teaches(id, A());
    expect((await list()).page.items).toHaveLength(1);
    await runAsSuperuser((tx) => deleteAccount(tx, { userId: id, by: 'self' }));
    expect((await list()).page.items).toEqual([]);
    expect((await one('ivan-petrov')).status).toBe(404);
    expect((await atVenue(venue.venueId)).items).toEqual([]);
  });
});

describe('the list', () => {
  it('is by page address, pages with a cursor, and filters by the sport taught', async () => {
    const [a, b, c] = [
      await coach('anna', 'Анна', { sports: ['TENNIS'] }),
      await coach('boris', 'Борис', { sports: ['PADEL'] }),
      await coach('viktor', 'Виктор', { sports: ['TENNIS', 'PADEL'] }),
    ];
    // Venue A is seeded with a padel court; Anna needs a tennis one to teach on.
    await asAppSuperuser(db, (tx) =>
      tx.resource.create({
        data: {
          tenantId: club.tenantId,
          venueId: venue.venueId,
          name: 'Tennis 1',
          sport: 'TENNIS',
          surface: 'CLAY',
          basePriceCents: 2000,
        },
      }),
    );
    for (const id of [c, a, b]) await teaches(id, A());

    expect((await list()).page.items.map((i) => i.slug)).toEqual(['anna', 'boris', 'viktor']);

    const first = await list('?limit=2');
    expect(first.page.items.map((i) => i.slug)).toEqual(['anna', 'boris']);
    expect(first.page.nextCursor).toBe('boris');
    const second = await list('?limit=2&cursor=boris');
    expect(second.page).toMatchObject({ nextCursor: null });
    expect(second.page.items.map((i) => i.slug)).toEqual(['viktor']);

    expect((await list('?sport=PADEL')).page.items.map((i) => i.slug)).toEqual(['boris', 'viktor']);
    expect((await list('?sport=SQUASH')).page.items).toEqual([]);
  });

  it.each([
    ['?sport=CURLING', 'sport'],
    ['?limit=0', 'limit'],
    ['?limit=51', 'limit'],
    ['?limit=ten', 'limit'],
    ['?cursor=Not%20A%20Slug', 'cursor'],
  ])('%s is a 400 that names the parameter', async (query, field) => {
    const res = await list(query);
    expect(res.status).toBe(400);
    expect(res.json.error?.details).toMatchObject({ field });
  });
});

describe('a coach’s page, and a venue’s coaches', () => {
  it('the page lists every venue they can be booked at, cheapest first, and the price from', async () => {
    const id = await coach('ivan-petrov', 'Иван Петров');
    await teaches(id, A(), { hourlyRateCents: 5000 });
    await teaches(id, A2(), { hourlyRateCents: 4500, lessonMinutes: [60] });
    await teaches(id, B(), { hourlyRateCents: 3000 });

    const { coach: c } = await one('ivan-petrov');
    expect(c.venues.map((v) => [v.name, v.club.name, v.hourlyRateCents])).toEqual([
      ['Бета Арена', 'Клуб Бета', 3000],
      ['Алфа Зала', 'Клуб Алфа', 4500],
      ['Алфа Кортове', 'Клуб Алфа', 5000],
    ]);
    expect(c.fromRateCents).toBe(3000);
  });

  it('a venue lists only its own coaches, with the rate there first', async () => {
    const ivan = await coach('ivan-petrov', 'Иван Петров');
    const maria = await coach('maria-ilieva', 'Мария Илиева');
    await teaches(ivan, A(), { hourlyRateCents: 5000 });
    await teaches(ivan, B(), { hourlyRateCents: 3000 });
    await teaches(maria, B());

    const here = await atVenue(venue.venueId);
    expect(here.status).toBe(200);
    expect(here.items.map((i) => i.slug)).toEqual(['ivan-petrov']);
    // Cheapest overall is the other club's; this page is about this venue.
    expect(here.items[0]!.venues.map((v) => [v.name, v.hourlyRateCents])).toEqual([
      ['Алфа Кортове', 5000],
      ['Бета Арена', 3000],
    ]);
    expect((await atVenue(venueOther.venueId)).items.map((i) => i.slug)).toEqual([
      'ivan-petrov',
      'maria-ilieva',
    ]);
    expect((await atVenue(venue2.venueId)).items).toEqual([]);
  });

  it.each([
    ['cnosuchvenue0000000000000', 200],
    ['no', 400],
  ])('a venue id that names nothing (%s) answers %d, with nobody listed', async (id, status) => {
    const res = await atVenue(id);
    expect(res.status).toBe(status);
    expect(res.items).toEqual([]);
  });

  it.each([['nobody-here'], ['Not A Slug'], ['a']])('%s is not a coach: 404', async (slug) => {
    expect((await one(slug)).status).toBe(404);
  });
});

describe('the sitemap', () => {
  it('has the listed coaches’ addresses and nobody else’s', async () => {
    const listed = await coach('anna', 'Анна');
    await teaches(listed, A());
    const nowhere = await coach('boris', 'Борис');
    await teaches(nowhere, A(), { hours: false });
    const draft = await coach('viktor', 'Виктор', { status: 'SUBMITTED' });
    await teaches(draft, A());

    const rows = await listSitemapCoaches(100);
    expect(rows.map((r) => r.slug)).toEqual(['anna']);
    expect(rows[0]!.updatedAt).toBeInstanceOf(Date);
  });
});
