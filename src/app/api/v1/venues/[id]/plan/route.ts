import { type NextRequest } from 'next/server';

import { getVenuePlan } from '@/app-layer/repositories/venue';
import { asSuperuser } from '@/app/api/v1/_lib/bind';
import { contextFromRequest } from '@/app/api/v1/_lib/context';
import { defineV1Route } from '@/app/api/v1/_lib/define-route';
import { ok } from '@/app/api/v1/_lib/envelope';
import { NotFoundError } from '@/lib/errors/types';
import { getRequestId } from '@/lib/observability/context';
import { parseOutline } from '@/lib/venues/plan';

/**
 * GET /api/v1/venues/{id}/plan — where the venue's courts lie (#623).
 *
 * Public, like the venue it belongs to. Each court on the plan with its
 * outline, a polygon in METRES from the venue's point (x east, y north), and
 * the plan's other shapes. A court with no outline, or one that is not a sane
 * polygon (`parseOutline`), is not on it. No courts on it means no plan: a
 * client keeps its list.
 *
 * `attribution` is `OpenStreetMap` while any shape shown came from OSM: its
 * licence (ODbL) asks for «© OpenStreetMap contributors» wherever it is shown.
 * Not personal data, so outside the export and deletion.
 */
async function handler(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await contextFromRequest(req, { slug: null, requestId: getRequestId() });
  // BYPASSRLS, as the venue detail: a public read has no tenant to bind to.
  // `publicVenueFilter` and this hand-written answer are what make it safe.
  const venue = await asSuperuser(ctx, (db) => getVenuePlan(db, id));
  if (!venue) throw new NotFoundError('Venue not found');

  const courts = venue.resources.flatMap((r) => {
    const outline = parseOutline(r.planOutline);
    return outline && r.planSource
      ? [
          {
            resourceId: r.id,
            name: r.name,
            sport: r.sport,
            resourceType: r.resourceType,
            outline,
            source: r.planSource,
          },
        ]
      : [];
  });
  const features = venue.planFeatures.flatMap((f) => {
    const outline = parseOutline(f.outline);
    return outline ? [{ kind: f.kind, outline, source: f.source }] : [];
  });
  const fromOsm = [...courts, ...features].some((shape) => shape.source === 'OSM');

  return ok({
    venueId: venue.id,
    courts,
    features: courts.length > 0 ? features : [],
    attribution: fromOsm && courts.length > 0 ? 'OpenStreetMap' : null,
  });
}

export const GET = defineV1Route(handler);
