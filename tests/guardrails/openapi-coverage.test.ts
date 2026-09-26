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

  /**
   * ═══ STRUCTURE, NOT JUST COVERAGE ═══
   *
   * Everything above asks whether the spec DESCRIBES the right things. Nothing
   * asked whether the document holds together.
   *
   * That gap matters more than it sounds for a hand-authored file that is
   * increasingly edited by script: #188 added two paths and six schemas that
   * way. A `$ref` pointing at a schema that was renamed produces a document
   * that reads perfectly, passes every assertion above, and generates a Swift
   * client that does not compile — so the failure lands in an iOS build, days
   * later, attributed to whoever is standing nearest.
   *
   * These three checks are what hand-editing actually breaks. A real validator
   * (`@redocly/cli`, `swagger-parser`) would be stricter, and is a dependency
   * for one file that `unused-dependencies` would want justifying. This is a
   * recursive walk and a pointer resolve.
   */
  describe('the document holds together', () => {
    /** Every `$ref` string anywhere in the document. */
    const refs = (() => {
      const found = new Set<string>();
      (function walk(node: unknown): void {
        if (node === null || typeof node !== 'object') return;
        const rec = node as Record<string, unknown>;
        if (typeof rec.$ref === 'string') found.add(rec.$ref);
        for (const v of Object.values(rec)) walk(v);
      })(spec);
      return [...found];
    })();

    /** Resolve a local JSON Pointer, honouring the ~0/~1 escapes. */
    function resolve(ref: string): unknown {
      if (!ref.startsWith('#/')) return undefined;
      let cur: unknown = spec;
      for (const raw of ref.slice(2).split('/')) {
        const seg = raw.replace(/~1/g, '/').replace(/~0/g, '~');
        if (cur === null || typeof cur !== 'object') return undefined;
        cur = (cur as Record<string, unknown>)[seg];
        if (cur === undefined) return undefined;
      }
      return cur;
    }

    it('found refs and schemas — a walk that matched nothing would pass everything', () => {
      expect(refs.length).toBeGreaterThanOrEqual(20);
      expect(Object.keys(spec.components?.schemas ?? {}).length).toBeGreaterThanOrEqual(20);
      // And that the resolver works, so "nothing dangled" means something.
      expect(resolve('#/components/schemas/Error')).toBeDefined();
      expect(resolve('#/components/schemas/NoSuchSchemaAnywhere')).toBeUndefined();
    });

    it('every $ref resolves', () => {
      const dangling = refs.filter((r) => resolve(r) === undefined);

      if (dangling.length > 0) {
        throw new Error(
          `These $refs point at nothing:\n\n` +
            dangling.map((r) => `  ${r}`).join('\n') +
            `\n\nThe spec still reads fine and every coverage check above still passes. The\n` +
            `generated Swift client is what breaks, in the iOS build, days from here.`,
        );
      }
    });

    it('no schema is declared and never referenced', () => {
      // An orphan is either dead weight the generator emits for nobody, or the
      // trace of an operation that was renamed and took its only reference with
      // it — which is worth looking at either way.
      const used = new Set(refs.map((r) => r.split('/').pop()));
      const orphans = Object.keys(spec.components?.schemas ?? {}).filter((n) => !used.has(n));

      expect(orphans).toEqual([]);
    });

    it('every `required` entry names a property that exists', () => {
      // `required: ['nextCursor']` beside `properties: { next_cursor }` is a
      // contract no response can satisfy, and the generator believes it: the
      // Swift type gets a non-optional field that is never populated, and
      // decoding throws on the first real response.
      const broken: string[] = [];

      (function walk(node: unknown, path: string): void {
        if (node === null || typeof node !== 'object') return;
        if (Array.isArray(node)) {
          node.forEach((v, i) => walk(v, `${path}[${i}]`));
          return;
        }
        const rec = node as Record<string, unknown>;

        if (Array.isArray(rec.required) && rec.properties && typeof rec.properties === 'object') {
          const props = Object.keys(rec.properties as Record<string, unknown>);
          for (const r of rec.required) {
            if (typeof r === 'string' && !props.includes(r)) {
              broken.push(`${path}: required "${r}" is not in properties [${props.join(', ')}]`);
            }
          }
        }

        for (const [k, v] of Object.entries(rec)) walk(v, `${path}/${k}`);
      })(spec, '#');

      expect(broken).toEqual([]);
    });
  });
});
