import { toMyBookingDto, toVenueSummary } from '@/app/api/v1/_lib/dto';

/**
 * The wire shapes T16 added: `toMyBookingDto`, and `clubSlug` on the venue
 * summary. Pure mappers, so pinned here without a database; the routes that
 * use them are exercised end to end in tests/integration/api-v1-me-bookings
 * and api-v1-venues-club-slug.
 */
describe('toMyBookingDto', () => {
  const row = {
    id: 'b1',
    startTs: new Date('2026-07-15T06:00:00.000Z'),
    endTs: new Date('2026-07-15T07:00:00.000Z'),
    status: 'COMPLETED',
    totalCents: 2400,
    currency: 'EUR',
    expiresAt: null,
    cancelledAt: null,
    createdAt: new Date('2026-07-01T10:11:12.345Z'),
    resource: {
      id: 'r1',
      name: 'Court 1',
      sport: 'PADEL',
      resourceType: 'COURT',
      venue: {
        id: 'v1',
        name: 'Padel Palace',
        timezone: 'Europe/Sofia',
        cancellationCutoffHours: 24,
      },
    },
    clubSlug: 'slot-club-sofia',
    venueReview: null,
    canReview: true,
    viewerRole: 'BOOKER' as const,
    // What the use case's row carries beyond the DTO. None of it may leak.
    tenantId: 't1',
    resourceId: 'r1',
  };

  it('is BookingDto plus clubSlug, venueReview, canReview, viewerRole and the lesson — and nothing else', () => {
    expect(toMyBookingDto(row)).toEqual({
      id: 'b1',
      status: 'COMPLETED',
      // RFC 3339 with no fractional seconds: Swift's default .iso8601 rejects them.
      startTs: '2026-07-15T06:00:00Z',
      endTs: '2026-07-15T07:00:00Z',
      totalCents: 2400,
      currency: 'EUR',
      expiresAt: null,
      cancelledAt: null,
      createdAt: '2026-07-01T10:11:12Z',
      // COMPLETED: not cancellable at all. The cutoff on the row is not published.
      cancellableUntil: null,
      // `resourceType` (P51): what the copy calls it — a TRACK is a "писта".
      resource: { id: 'r1', name: 'Court 1', sport: 'PADEL', resourceType: 'COURT' },
      venue: { id: 'v1', name: 'Padel Palace', timezone: 'Europe/Sofia' },
      clubSlug: 'slot-club-sofia',
      venueReview: null,
      canReview: true,
      viewerRole: 'BOOKER',
      // A plain court booking: said as null, never left out.
      lesson: null,
    });
  });

  describe('a booking with a lesson on it (#548)', () => {
    const lessonRow = {
      ...row,
      status: 'CONFIRMED',
      lesson: {
        id: 'ls1',
        coachUserId: 'u_coach',
        coachFeeCents: 4000,
        groupRateCents: 6000,
        cancelCutoffHours: 48,
      },
      lessonCoach: { slug: 'ivan-petrov', name: 'Иван Петров' },
    };

    it('says who teaches it and the price in its parts; the booking’s own total stays the court’s', () => {
      const dto = toMyBookingDto(lessonRow);
      expect(dto.totalCents).toBe(2400);
      expect(dto.lesson).toEqual({
        id: 'ls1',
        coach: { slug: 'ivan-petrov', name: 'Иван Петров' },
        coachFeeCents: 4000,
        // The group RATE is per hour; the lesson is one hour.
        groupFeeCents: 6000,
        courtPriceCents: 2400,
        totalCents: 6400,
        // Nobody has reviewed the coach, and nothing says one may (#551).
        myReview: null,
        canReview: false,
      });
      // The coach's account id and the cutoff are for the server, not the wire.
      expect(JSON.stringify(dto)).not.toMatch(/u_coach|cancelCutoffHours|coachUserId/);
    });

    it('the deadline is the stricter of the club’s cutoff and the coach’s', () => {
      // The club's 24 hours and the coach's 48: two days before the start.
      expect(toMyBookingDto(lessonRow).cancellableUntil).toBe('2026-07-13T06:00:00Z');
      // A coach who asks for less does not loosen the club's rule.
      expect(
        toMyBookingDto({ ...lessonRow, lesson: { ...lessonRow.lesson, cancelCutoffHours: 2 } })
          .cancellableUntil,
      ).toBe('2026-07-14T06:00:00Z');
    });

    it('a group fee is for the lesson’s length; none when the coach gives no group lessons', () => {
      const ninety = { ...lessonRow, endTs: new Date('2026-07-15T07:30:00Z') };
      expect(toMyBookingDto(ninety).lesson!.groupFeeCents).toBe(9000);
      expect(
        toMyBookingDto({ ...lessonRow, lesson: { ...lessonRow.lesson, groupRateCents: null } })
          .lesson!.groupFeeCents,
      ).toBeNull();
    });

    it('a coach who cannot be found is a lesson with nobody named', () => {
      expect(toMyBookingDto({ ...lessonRow, lessonCoach: null }).lesson!.coach).toEqual({
        slug: null,
        name: null,
      });
    });
  });

  it('says until when the PLAYER may cancel a live booking: the cutoff before the start', () => {
    const dto = toMyBookingDto({ ...row, status: 'CONFIRMED' });
    expect(dto.cancellableUntil).toBe('2026-07-14T06:00:00Z');
    expect(dto.venue).toEqual({ id: 'v1', name: 'Padel Palace', timezone: 'Europe/Sofia' });
  });

  it('tells an added player there is nothing for them to cancel (#358)', () => {
    const dto = toMyBookingDto({ ...row, status: 'CONFIRMED', viewerRole: 'PARTICIPANT' });
    expect(dto.viewerRole).toBe('PARTICIPANT');
    expect(dto.cancellableUntil).toBeNull();
  });

  it('rebuilds the review rather than passing the row through', () => {
    const dto = toMyBookingDto({
      ...row,
      canReview: false,
      venueReview: {
        id: 'rv1',
        bookingId: 'b0',
        rating: 5,
        status: 'PUBLISHED',
        // A field a later use case might add — the mapper must not publish it.
        ...({ moderationScoresJson: { toxicity: 0.9 } } as object),
      },
    });
    expect(dto.venueReview).toEqual({ id: 'rv1', bookingId: 'b0', rating: 5, status: 'PUBLISHED' });
    expect(dto.canReview).toBe(false);
  });
});

describe('toVenueSummary', () => {
  it("carries the club's slug beside the venue's own, and they are different fields", () => {
    const venue = {
      id: 'v1',
      slug: 'central-courts',
      name: 'Central Courts',
      city: 'Sofia',
      country: 'BG',
      avgRating: 4.5,
      reviewCount: 2,
      coverPhotoUrl: null,
      resources: [{ status: 'ACTIVE', sport: 'PADEL', basePriceCents: 2400 }],
    } as unknown as Parameters<typeof toVenueSummary>[0];

    const dto = toVenueSummary(venue, 'slot-club-sofia');
    expect(dto.slug).toBe('central-courts');
    expect(dto.clubSlug).toBe('slot-club-sofia');
    expect(Object.keys(dto)).not.toContain('tenantId');
  });
});
