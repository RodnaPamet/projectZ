import type { PrismaClient } from '@prisma/client';

import { deleteAccount, deletionStanding } from '@/app-layer/usecases/account-deletion';
import { runAsSuperuser, runAsUserOnly } from '@/lib/db/rls-middleware';

import {
  prismaTestClient,
  resetDatabase,
  seedAccount,
  seedTenant,
  seedVenue,
  type SeededTenant,
} from '../helpers/db';
import { asAppSuperuser, asAppUser } from '../helpers/rls';

/**
 * THE COACH TABLES (#544, P71), as the database holds them. No use case
 * writes them yet: these are the rules every later writer inherits.
 *
 *   - one coach, one place at a time, ACROSS clubs;
 *   - a lesson follows its booking, whoever moves or cancels it;
 *   - a coach's profile and certificate are their own;
 *   - a coach with a lesson still to teach cannot delete the account, and
 *     afterwards nothing personal of theirs is left.
 */

const HOUR = 3_600_000;
const pgCode = (e: unknown): string | undefined =>
  (e as { code?: string; meta?: { code?: string } }).meta?.code ??
  /Code: `(\w+)`/.exec(String(e))?.[1] ??
  /\b(23P01|23514|23505)\b/.exec(String(e))?.[1];

describe('the coach tables (#544, P71)', () => {
  const db = prismaTestClient();
  let a: SeededTenant;
  let b: SeededTenant;
  let venueA: { venueId: string; resourceId: string };
  let venueB: { venueId: string; resourceId: string };
  let coachUser: string;
  let linkA: string;
  let linkB: string;
  let player: string;

  const at = (hoursFromNow: number) => new Date(Date.now() + hoursFromNow * HOUR);

  /** A coach's link to a venue, ACTIVE, with terms. */
  const link = (tenantId: string, venueId: string, userId: string) =>
    asAppSuperuser(db, (tx) =>
      tx.coach.create({
        data: {
          tenantId,
          venueId,
          userId,
          status: 'ACTIVE',
          startedBy: 'COACH',
          hourlyRateCents: 4000,
          groupRateCents: 6000,
          lessonMinutes: [60, 90],
          cancelCutoffHours: 12,
        },
        select: { id: true },
      }),
    ).then((c) => c.id);

  /** A court booking with a lesson on it, written as one transaction would. */
  async function lesson(
    tx: PrismaClient,
    o: {
      tenantId: string;
      resourceId: string;
      coachId: string;
      coachUserId?: string;
      start: Date;
      end: Date;
    },
  ) {
    const booking = await tx.booking.create({
      data: {
        tenantId: o.tenantId,
        resourceId: o.resourceId,
        startTs: o.start,
        endTs: o.end,
        status: 'CONFIRMED',
        totalCents: 2400,
        idempotencyKey: `k-${Math.random().toString(36).slice(2)}`,
        bookedByUserId: player,
      },
      select: { id: true },
    });
    const l = await tx.coachLesson.create({
      data: {
        tenantId: o.tenantId,
        bookingId: booking.id,
        coachId: o.coachId,
        coachUserId: o.coachUserId ?? coachUser,
        startTs: o.start,
        endTs: o.end,
        hourlyRateCents: 4000,
        groupRateCents: 6000,
        cancelCutoffHours: 12,
        coachFeeCents: 4000,
      },
      select: { id: true },
    });
    return { bookingId: booking.id, lessonId: l.id };
  }
  const lessonRow = (id: string) =>
    asAppSuperuser(db, (tx) =>
      tx.coachLesson.findUniqueOrThrow({
        where: { id },
        select: { startTs: true, endTs: true, active: true },
      }),
    );

  beforeEach(async () => {
    await resetDatabase(db);
    a = await seedTenant({ name: 'Club A' }, db);
    b = await seedTenant({ name: 'Club B' }, db);
    venueA = await seedVenue(a.tenantId, {}, db);
    venueB = await seedVenue(b.tenantId, {}, db);
    coachUser = await seedAccount('COACH', db);
    player = await seedAccount('PLAYER', db);
    linkA = await link(a.tenantId, venueA.venueId, coachUser);
    linkB = await link(b.tenantId, venueB.venueId, coachUser);
  });

  // ─── one coach, one place at a time ────────────────────────────────

  it('a coach cannot be in two lessons at once, even at two different clubs', async () => {
    await asAppSuperuser(db, (tx) =>
      lesson(tx, {
        tenantId: a.tenantId,
        resourceId: venueA.resourceId,
        coachId: linkA,
        start: at(24),
        end: at(25),
      }),
    );
    // Another club, another court, the same hour: only the coach is the same.
    const clash = asAppSuperuser(db, (tx) =>
      lesson(tx, {
        tenantId: b.tenantId,
        resourceId: venueB.resourceId,
        coachId: linkB,
        start: at(24.5),
        end: at(25.5),
      }),
    );
    await expect(clash).rejects.toThrow(/coach_lesson_no_overlap/);
    await clash.catch((e) => expect(pgCode(e)).toBe('23P01'));
    // The court's booking went with it: nothing half-made is left at club B.
    expect(
      await asAppSuperuser(db, (tx) => tx.booking.count({ where: { tenantId: b.tenantId } })),
    ).toBe(0);
  });

  it('back-to-back lessons are legal, and so is another coach at the same hour', async () => {
    await asAppSuperuser(db, (tx) =>
      lesson(tx, {
        tenantId: a.tenantId,
        resourceId: venueA.resourceId,
        coachId: linkA,
        start: at(24),
        end: at(25),
      }),
    );
    await expect(
      asAppSuperuser(db, (tx) =>
        lesson(tx, {
          tenantId: b.tenantId,
          resourceId: venueB.resourceId,
          coachId: linkB,
          start: at(25),
          end: at(26),
        }),
      ),
    ).resolves.toBeDefined();

    const other = await seedAccount('COACH', db);
    const otherLink = await link(b.tenantId, venueB.venueId, other);
    await expect(
      asAppSuperuser(db, (tx) =>
        lesson(tx, {
          tenantId: b.tenantId,
          resourceId: venueB.resourceId,
          coachId: otherLink,
          coachUserId: other,
          start: at(30),
          end: at(31),
        }),
      ),
    ).resolves.toBeDefined();
  });

  // ─── a lesson follows its booking ──────────────────────────────────

  it('cancelling the booking frees the coach, without any code touching the lesson', async () => {
    const first = await asAppSuperuser(db, (tx) =>
      lesson(tx, {
        tenantId: a.tenantId,
        resourceId: venueA.resourceId,
        coachId: linkA,
        start: at(24),
        end: at(25),
      }),
    );
    expect((await lessonRow(first.lessonId)).active).toBe(true);

    // As a player's cancel does it: the booking's status, nothing else.
    await asAppSuperuser(db, (tx) =>
      tx.booking.update({ where: { id: first.bookingId }, data: { status: 'CANCELLED' } }),
    );
    expect((await lessonRow(first.lessonId)).active).toBe(false);

    // The same hour is the coach's again, at another club.
    await expect(
      asAppSuperuser(db, (tx) =>
        lesson(tx, {
          tenantId: b.tenantId,
          resourceId: venueB.resourceId,
          coachId: linkB,
          start: at(24),
          end: at(25),
        }),
      ),
    ).resolves.toBeDefined();
  });

  it.each(['COMPLETED', 'NO_SHOW'] as const)(
    'a booking that is %s no longer holds the coach either',
    async (status) => {
      const l = await asAppSuperuser(db, (tx) =>
        lesson(tx, {
          tenantId: a.tenantId,
          resourceId: venueA.resourceId,
          coachId: linkA,
          start: at(24),
          end: at(25),
        }),
      );
      await asAppSuperuser(db, (tx) =>
        tx.booking.update({ where: { id: l.bookingId }, data: { status } }),
      );
      expect((await lessonRow(l.lessonId)).active).toBe(false);
    },
  );

  it('moving the booking moves the lesson with it', async () => {
    const l = await asAppSuperuser(db, (tx) =>
      lesson(tx, {
        tenantId: a.tenantId,
        resourceId: venueA.resourceId,
        coachId: linkA,
        start: at(24),
        end: at(25),
      }),
    );
    const start = at(48);
    const end = at(49.5);
    await asAppSuperuser(db, (tx) =>
      tx.booking.update({ where: { id: l.bookingId }, data: { startTs: start, endTs: end } }),
    );
    const row = await lessonRow(l.lessonId);
    expect(row.startTs.getTime()).toBe(start.getTime());
    expect(row.endTs.getTime()).toBe(end.getTime());
    expect(row.active).toBe(true);
  });

  it('a move onto an hour the coach already teaches is refused, and the booking stays where it was', async () => {
    const taught = await asAppSuperuser(db, (tx) =>
      lesson(tx, {
        tenantId: b.tenantId,
        resourceId: venueB.resourceId,
        coachId: linkB,
        start: at(48),
        end: at(49),
      }),
    );
    const moved = await asAppSuperuser(db, (tx) =>
      lesson(tx, {
        tenantId: a.tenantId,
        resourceId: venueA.resourceId,
        coachId: linkA,
        start: at(24),
        end: at(25),
      }),
    );
    const before = await lessonRow(moved.lessonId);

    // The desk at club A moves its booking; it knows nothing of club B.
    await expect(
      asAppUser(db, a.tenantId, (tx) =>
        tx.booking.update({
          where: { id: moved.bookingId },
          data: { startTs: at(48.5), endTs: at(49.5) },
        }),
      ),
    ).rejects.toThrow(/coach_lesson_no_overlap/);

    const booking = await asAppSuperuser(db, (tx) =>
      tx.booking.findUniqueOrThrow({ where: { id: moved.bookingId }, select: { startTs: true } }),
    );
    expect(booking.startTs.getTime()).toBe(before.startTs.getTime());
    expect((await lessonRow(moved.lessonId)).startTs.getTime()).toBe(before.startTs.getTime());
    expect((await lessonRow(taught.lessonId)).active).toBe(true);
  });

  it('a booking with no lesson is moved and cancelled exactly as before', async () => {
    const plain = await asAppSuperuser(db, (tx) =>
      tx.booking.create({
        data: {
          tenantId: a.tenantId,
          resourceId: venueA.resourceId,
          startTs: at(24),
          endTs: at(25),
          status: 'CONFIRMED',
          totalCents: 2400,
          idempotencyKey: 'plain',
          bookedByUserId: player,
        },
        select: { id: true },
      }),
    );
    await expect(
      asAppUser(db, a.tenantId, (tx) =>
        tx.booking.update({ where: { id: plain.id }, data: { status: 'CANCELLED' } }),
      ),
    ).resolves.toBeDefined();
  });

  // ─── what the columns refuse ───────────────────────────────────────

  it('the floor under the use cases: lengths, rates, cutoff, levels, rating, the certificate', async () => {
    const bad = (fn: (tx: PrismaClient) => Promise<unknown>) =>
      expect(asAppSuperuser(db, fn)).rejects.toThrow();

    await bad((tx) => tx.coach.update({ where: { id: linkA }, data: { lessonMinutes: [5] } }));
    await bad((tx) =>
      tx.coach.update({ where: { id: linkA }, data: { lessonMinutes: [60, 300] } }),
    );
    await bad((tx) => tx.coach.update({ where: { id: linkA }, data: { hourlyRateCents: -1 } }));
    await bad((tx) => tx.coach.update({ where: { id: linkA }, data: { groupRateCents: 100_001 } }));
    await bad((tx) => tx.coach.update({ where: { id: linkA }, data: { cancelCutoffHours: 169 } }));
    await bad((tx) => tx.coach.update({ where: { id: linkA }, data: { startedBy: 'NOBODY' } }));
    await bad((tx) =>
      tx.coachAvailability.create({
        data: {
          tenantId: a.tenantId,
          coachId: linkA,
          dayOfWeek: 7,
          openTime: new Date('1970-01-01T09:00:00Z'),
          closeTime: new Date('1970-01-01T12:00:00Z'),
        },
      }),
    );
    await bad((tx) =>
      tx.coachAvailability.create({
        data: {
          tenantId: a.tenantId,
          coachId: linkA,
          dayOfWeek: 1,
          openTime: new Date('1970-01-01T12:00:00Z'),
          closeTime: new Date('1970-01-01T09:00:00Z'),
        },
      }),
    );
    await bad((tx) =>
      tx.coachProfile.create({ data: { userId: coachUser, slug: 'Not A Slug', bio: null } }),
    );
    await bad((tx) =>
      tx.coachProfile.create({ data: { userId: coachUser, slug: 'ivan', bio: 'я'.repeat(1001) } }),
    );
    // A decision without who and when is not a decision.
    await bad((tx) =>
      tx.coachProfile.create({ data: { userId: coachUser, slug: 'ivan', status: 'APPROVED' } }),
    );
    await bad((tx) =>
      tx.coachTimeOff.create({
        data: {
          userId: coachUser,
          startDate: new Date('2036-08-10'),
          endDate: new Date('2036-08-01'),
        },
      }),
    );
    await bad((tx) =>
      tx.coachCertificate.create({
        data: {
          userId: coachUser,
          fileName: 'cert.exe',
          mimeType: 'application/x-msdownload',
          byteSize: 10,
          sha256: 'a'.repeat(64),
          content: Buffer.from('x'),
        },
      }),
    );
    await bad((tx) =>
      tx.coachCertificate.create({
        data: {
          userId: coachUser,
          fileName: 'cert.pdf',
          mimeType: 'application/pdf',
          byteSize: 5 * 1024 * 1024 + 1,
          sha256: 'a'.repeat(64),
          content: Buffer.from('x'),
        },
      }),
    );

    // And what is in range is taken.
    await expect(
      asAppSuperuser(db, async (tx) => {
        await tx.coachProfile.create({
          data: {
            userId: coachUser,
            slug: 'ivan-petrov',
            bio: 'Тенис треньор от 2010 г.',
            sports: { create: [{ sport: 'TENNIS', levelMin: 1, levelMax: 5 }] },
          },
        });
        await tx.coachCertificate.create({
          data: {
            userId: coachUser,
            fileName: 'cert.pdf',
            mimeType: 'application/pdf',
            byteSize: 1024,
            sha256: 'b'.repeat(64),
            content: Buffer.from('ciphertext'),
          },
        });
      }),
    ).resolves.toBeUndefined();
    await bad((tx) =>
      tx.coachProfileSport.create({
        data: { userId: coachUser, sport: 'PADEL', levelMin: 5, levelMax: 3 },
      }),
    );
  });

  // ─── a profile and a certificate are their owner's ─────────────────

  it('a coach reads their own profile and certificate; another account, and a club, read neither', async () => {
    await asAppSuperuser(db, async (tx) => {
      await tx.coachProfile.create({ data: { userId: coachUser, slug: 'ivan-petrov' } });
      await tx.coachCertificate.create({
        data: {
          userId: coachUser,
          fileName: 'cert.pdf',
          mimeType: 'application/pdf',
          byteSize: 1024,
          sha256: 'c'.repeat(64),
          content: Buffer.from('ciphertext'),
        },
      });
      await tx.coachTimeOff.create({
        data: {
          userId: coachUser,
          startDate: new Date('2036-08-01'),
          endDate: new Date('2036-08-10'),
        },
      });
    });

    const mine = await runAsUserOnly(coachUser, async (tx) => ({
      profile: await tx.coachProfile.count(),
      certificate: await tx.coachCertificate.count(),
      timeOff: await tx.coachTimeOff.count(),
    }));
    expect(mine).toEqual({ profile: 1, certificate: 1, timeOff: 1 });

    const theirs = await runAsUserOnly(player, async (tx) => ({
      profile: await tx.coachProfile.count(),
      certificate: await tx.coachCertificate.count(),
      timeOff: await tx.coachTimeOff.count(),
    }));
    expect(theirs).toEqual({ profile: 0, certificate: 0, timeOff: 0 });

    // A club the coach teaches at, bound as itself: still neither. A club
    // never sees the certificate (decision 17).
    const club = await asAppUser(db, a.tenantId, async (tx) => ({
      profile: await tx.coachProfile.count(),
      certificate: await tx.coachCertificate.count(),
      link: await tx.coach.count(),
    }));
    expect(club).toEqual({ profile: 0, certificate: 0, link: 1 });
    // And club B sees its own link only.
    expect(await asAppUser(db, b.tenantId, (tx) => tx.coach.count())).toBe(1);
  });

  // ─── deleting a coach's account ────────────────────────────────────

  it('a lesson still to be taught blocks the deletion; afterwards nothing personal is left', async () => {
    await asAppSuperuser(db, async (tx) => {
      await tx.coachProfile.create({
        data: {
          userId: coachUser,
          slug: 'ivan-petrov',
          bio: 'Тенис',
          sports: { create: [{ sport: 'TENNIS', levelMin: 1, levelMax: 5 }] },
        },
      });
      await tx.coachCertificate.create({
        data: {
          userId: coachUser,
          fileName: 'cert.pdf',
          mimeType: 'application/pdf',
          byteSize: 1024,
          sha256: 'd'.repeat(64),
          content: Buffer.from('ciphertext'),
        },
      });
      await tx.coachTimeOff.create({
        data: {
          userId: coachUser,
          startDate: new Date('2036-08-01'),
          endDate: new Date('2036-08-02'),
        },
      });
      await tx.coachAvailability.create({
        data: {
          tenantId: a.tenantId,
          coachId: linkA,
          dayOfWeek: 1,
          openTime: new Date('1970-01-01T09:00:00Z'),
          closeTime: new Date('1970-01-01T12:00:00Z'),
        },
      });
    });
    const upcoming = await asAppSuperuser(db, (tx) =>
      lesson(tx, {
        tenantId: a.tenantId,
        resourceId: venueA.resourceId,
        coachId: linkA,
        start: at(24),
        end: at(25),
      }),
    );

    // Blocked: the coach has a lesson to teach.
    const standing = await runAsSuperuser((tx) => deletionStanding(tx, coachUser));
    expect(standing).toMatchObject({ kind: 'blocked', total: 0, lessons: 1 });
    await expect(
      runAsSuperuser((tx) => deleteAccount(tx, { userId: coachUser, by: 'self' })),
    ).rejects.toMatchObject({ name: 'UpcomingBookingsError', lessons: 1 });

    // The coach cancels it (decision 8), and may then go.
    await asAppSuperuser(db, (tx) =>
      tx.booking.update({ where: { id: upcoming.bookingId }, data: { status: 'CANCELLED' } }),
    );
    expect(await runAsSuperuser((tx) => deletionStanding(tx, coachUser))).toMatchObject({
      kind: 'allowed',
    });
    await runAsSuperuser((tx) => deleteAccount(tx, { userId: coachUser, by: 'self' }));

    const left = await asAppSuperuser(db, async (tx) => ({
      profile: await tx.coachProfile.count({ where: { userId: coachUser } }),
      sports: await tx.coachProfileSport.count({ where: { userId: coachUser } }),
      certificate: await tx.coachCertificate.count({ where: { userId: coachUser } }),
      timeOff: await tx.coachTimeOff.count({ where: { userId: coachUser } }),
      hours: await tx.coachAvailability.count({ where: { coachId: { in: [linkA, linkB] } } }),
      links: await tx.coach.findMany({
        where: { userId: coachUser },
        select: { status: true, endedByUserId: true },
      }),
      // The lesson that was booked and cancelled stays with its booking.
      lessons: await tx.coachLesson.count({ where: { coachUserId: coachUser } }),
    }));
    expect(left).toEqual({
      profile: 0,
      sports: 0,
      certificate: 0,
      timeOff: 0,
      hours: 0,
      links: [
        { status: 'ENDED', endedByUserId: coachUser },
        { status: 'ENDED', endedByUserId: coachUser },
      ],
      lessons: 1,
    });
  });

  it('a player who booked a lesson is blocked by the booking, as by any other', async () => {
    await asAppSuperuser(db, (tx) =>
      lesson(tx, {
        tenantId: a.tenantId,
        resourceId: venueA.resourceId,
        coachId: linkA,
        start: at(24),
        end: at(25),
      }),
    );
    const standing = await runAsSuperuser((tx) => deletionStanding(tx, player));
    // One booking to cancel; no lesson to TEACH.
    expect(standing).toMatchObject({ kind: 'blocked', total: 1, lessons: 0 });
  });
});
