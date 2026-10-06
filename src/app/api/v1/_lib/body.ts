import type { NextRequest } from 'next/server';
import type { z } from 'zod';

import { ValidationError } from '@/lib/errors/types';

/**
 * A JSON body, parsed by `schema`, or a 400 naming the field at fault.
 *
 * The shape `PATCH /me` answers with (#359), shared by the routes that came
 * after it (#358, #360): `code: BAD_REQUEST`, `details.field` the top-level
 * property at fault (for an unknown key under `.strict()`, the key itself),
 * and `details.issues` the zod issues.
 */
export async function parseJsonBody<S extends z.ZodType>(
  req: NextRequest,
  schema: S,
  what: string,
): Promise<z.infer<S>> {
  const raw: unknown = await req.json().catch(() => {
    throw new ValidationError('Body must be JSON');
  });

  const parsed = schema.safeParse(raw);
  if (parsed.success) return parsed.data;

  const first = parsed.error.issues[0];
  const field = first?.path.length
    ? String(first.path[0])
    : first?.code === 'unrecognized_keys'
      ? first.keys[0]
      : undefined;
  throw new ValidationError(`Invalid ${what}`, {
    ...(field ? { field } : {}),
    issues: parsed.error.issues.map((i) => ({ path: i.path, code: i.code, message: i.message })),
  });
}
