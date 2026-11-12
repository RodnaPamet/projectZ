import { type NextRequest } from 'next/server';

import { listVenueFacets } from '@/app-layer/repositories/venue';
import { asSuperuser } from '@/app/api/v1/_lib/bind';
import { cityNames } from '@/app/api/v1/_lib/city-names';
import { contextFromRequest } from '@/app/api/v1/_lib/context';
import { defineV1Route } from '@/app/api/v1/_lib/define-route';
import { ok } from '@/app/api/v1/_lib/envelope';
import { cityKey } from '@/lib/geo/cities';
import { getRequestId } from '@/lib/observability/context';

/**
 * GET /api/v1/venues/facets — what the venue filters can offer (#667): the
 * cities with a live venue and the sports with a live court, from the same
 * query /venues uses (#357). Public, like the list.
 *
 * Without it the phone built its city chips from the venue pages it had
 * loaded, so a city on a later page was missing and `Sofia` / `София` came
 * back as two cities. Each city carries `value`, what `?city=` takes: the
 * canonical key, or the typed text for a city outside the list.
 */
async function handler(req: NextRequest) {
  const ctx = await contextFromRequest(req, { slug: null, requestId: getRequestId() });
  const facets = await asSuperuser(ctx, (db) => listVenueFacets(db));

  const cities = facets.cities.map((city) => {
    const key = cityKey(city);
    return { value: key ?? city, key, names: cityNames(city, key) };
  });
  return ok({ cities, sports: facets.sports });
}

export const GET = defineV1Route(handler);
