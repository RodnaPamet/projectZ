import { globSync, readFileSync } from 'node:fs';

import { exportsMethod } from '../helpers/route-exports';

/**
 * THE SPEC DESCRIBES EVERY v1 ROUTE, OR THE BUILD FAILS.
 *
 * ═══ WHY A HAND-WRITTEN SPEC NEEDS THIS MORE THAN A GENERATED ONE ═══
 *
 * A generated spec is wrong in obvious ways — it fails to build. A
 * hand-written one is wrong in the worst way: it stays plausible while the
 * code moves underneath it. The iOS client is generated FROM this file, so a
 * spec that quietly omits a route produces a client that cannot call it, and a
 * spec that describes a route that no longer exists produces a client that
 * calls a 404. Neither fails here; both fail in a shipped binary.
 *
 * So the ratchet is coverage, both ways:
 *
 *   - every exported HTTP method of every `src/app/api/v1/**\/route.ts` has a
 *     matching path + operation in the spec;
 *   - every path in the spec corresponds to a route that exists.
 *
 * It does NOT check that the SCHEMAS are right. That would need the DTOs to be
 * runtime values rather than TypeScript interfaces, which they are not. This
 * catches the failure that actually happens — a route added, renamed or
 * deleted without the spec following — and is silent about the one it cannot
 * see. Saying so is better than implying more.
 */

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;

/** `src/app/api/v1/t/[slug]/bookings/[id]/cancel` → `/t/{slug}/bookings/{id}/cancel` */
function toSpecPath(file: string): string {
  return (
    '/' +
    file
      .replace(/^src\/app\/api\/v1\//, '')
      .replace(/\/route\.ts$/, '')
      .replace(/\[([^\]]+)\]/g, '{$1}')
  );
}

interface OpenApiDoc {
  openapi?: string;
  paths?: Record<string, Record<string, unknown>>;
  components?: { schemas?: Record<string, unknown> };
}

describe('OpenAPI coverage', () => {
  const routeFiles = globSync('src/app/api/v1/**/route.ts').map((f) => f.toString());
  const spec = JSON.parse(readFileSync('openapi/playerz-v1.json', 'utf8')) as OpenApiDoc;

  /**
   * Every (method, specPath) this suite is going to check, resolved ONCE.
   *
   * Hoisted out of the test so the sanity check below can count it. It used to
   * be computed inside the assertion, where nothing could see it — and a
   * detector that matched nothing produced an empty `missing` array and a
   * green suite, with the glob assertions still passing happily above it.
   */
  const discovered: Array<[string, string]> = routeFiles.flatMap((file) => {
    const src = readFileSync(file, 'utf8');
    const specPath = toSpecPath(file);
    return METHODS.filter((m) => exportsMethod(src, m)).map(
      (m) => [m, specPath] as [string, string],
    );
  });

  it('found the routes and the spec — a broken glob would pass everything', () => {
    expect(routeFiles.length).toBeGreaterThanOrEqual(10);
    expect(spec.openapi).toMatch(/^3\./);
    expect(Object.keys(spec.paths ?? {}).length).toBeGreaterThanOrEqual(10);

    // And that the DETECTOR found something. The glob checks above prove the
    // files were read; they say nothing about whether any HTTP verb was
    // recognised inside them, which is the half that actually drives the
    // coverage assertion. 21 pairs exist today; 15 leaves room to delete a
    // route without turning this into a tripwire.
    expect(discovered.length).toBeGreaterThanOrEqual(15);
  });

  it('every route + method is described', () => {
    const missing = discovered
      .filter(([method, specPath]) => !spec.paths?.[specPath]?.[method.toLowerCase()])
      .map(([method, specPath]) => `${method} ${specPath}`);

    expect(missing).toEqual([]);
  });

  it('describes no route that does not exist', () => {
    // The other direction. A path left behind after a rename generates a
    // client method that calls a 404, which looks like a server bug.
    const real = new Set(routeFiles.map(toSpecPath));
    const phantom = Object.keys(spec.paths ?? {}).filter((p) => !real.has(p));

    expect(phantom).toEqual([]);
  });

  it('every operation says what it returns and who may call it', () => {
    // An operation with no responses generates a client method returning
    // nothing useful; one with no security marker leaves the caller guessing
    // whether a token is required.
    const incomplete: string[] = [];

    for (const [path, ops] of Object.entries(spec.paths ?? {})) {
      for (const [method, op] of Object.entries(ops)) {
        // A Path Item may carry `parameters`, `summary` or `$ref` alongside its
        // operations. Treating those as operations would demand `responses` of
        // something that is not one — the guardrail would be wrong, not the spec.
        if (!METHODS.includes(method.toUpperCase() as (typeof METHODS)[number])) continue;
        const o = op as { responses?: Record<string, unknown>; security?: unknown[] };
        if (!o.responses || Object.keys(o.responses).length === 0) {
          incomplete.push(`${method.toUpperCase()} ${path}: no responses`);
        }
        if (o.security === undefined) {
          incomplete.push(`${method.toUpperCase()} ${path}: no security declared`);
        }
      }
    }

    expect(incomplete).toEqual([]);
  });
});
