import { globSync, readFileSync } from 'node:fs';

import { exportsMethod } from '../helpers/route-exports';

/**
 * EVERY ROUTE UNDER /api/v1/platform IS AUDITED, OR THE BUILD FAILS.
 *
 * ═══ THE TWO FAILURES THIS CATCHES, BOTH SILENT ═══
 *
 * **Forgetting `platformRoute: true`.** `contextFromRequest` only resolves the
 * grant when asked. Without the flag `ctx.appPermissions` stays `[]` and
 * `ctx.platformGrantId` stays undefined, so `asPlatformAdmin` throws
 * MissingPlatformGrantError for EVERY caller including a legitimate admin. That
 * is fail-closed, which is the right direction — and it presents as "platform
 * admin is broken for everyone", which is the kind of bug that gets fixed by
 * reaching for `asSuperuser` instead.
 *
 * **Reaching for `asSuperuser`.** Same reach, no audit row, no capability
 * check, no grant. `superuser-call-sites.test.ts` pins WHICH files may do it,
 * so a new platform route would be caught there too — but it would be caught as
 * "a file was added to a list", which is a conversation about a list. Here it
 * is caught as "a platform route skipped the audit", which is the actual
 * objection.
 *
 * ═══ WHY IT RESOLVES THE HANDLER RATHER THAN SCANNING THE FILE ═══
 *
 * A route file that exports two methods sharing one audited handler is the
 * shape both current routes have. If this only asked "does the file mention
 * asPlatformAdmin", then adding
 *
 *     export const DELETE = defineV1Route(deleteHandler);
 *
 * next to an audited GET would pass while `deleteHandler` bound nothing at all.
 * That is the realistic mistake — the second method, added later, by someone
 * reading a file that already looks compliant.
 *
 * So each exported verb is followed to the declaration it names, and through
 * whatever that declaration names in turn.
 *
 * ═══ WHAT IT CANNOT SEE ═══
 *
 * A handler that calls `asPlatformAdmin` for one branch and returns club data
 * from another. Nothing textual can see that. This checks that the binding is
 * REACHED, not that it is the only path — and saying so is better than
 * implying more.
 */

const PLATFORM_TREE = 'src/app/api/v1/platform/';

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const;

/** The bindings that give the same reach with none of the accountability. */
const UNAUDITED = /\b(?:runAsSuperuser|asSuperuser)\b/;

/** Tenant bindings, which a platform route must not mix in. */
const TENANT_BOUND = /\b(?:runInTenantContext|inTenant)\b/;

/**
 * Comments and string bodies blanked, so every check below reads CODE.
 *
 * Both routes explain at length why they do not use `asSuperuser`. A raw-text
 * scan would read those sentences as the violation they warn against — and,
 * worse, would keep passing the `asPlatformAdmin` check on a file where the
 * call had been deleted but the docblock describing it remained.
 *
 * ═══ WHY THIS SCANS CHARACTERS RATHER THAN FILTERING LINES ═══
 *
 * The first version dropped whole lines whose trimmed form began with `//`,
 * `/*` or `*`. That leaves a TRAILING comment intact, and it leaves string
 * literals intact, so both of these passed the central assertion for a route
 * that never calls the binding:
 *
 *     return everyClubsRevenue(ctx); // asPlatformAdmin runs inside the use case
 *     throw new Error('asPlatformAdmin requires a signed-in caller');
 *
 * The second is the realistic one: a route that reaches cross-club data through
 * a helper doing its own `runAsSuperuser`, with an honest comment explaining
 * itself, and a green build. So this walks the source instead, tracking whether
 * it is inside a comment, a quoted string or a template literal, and blanks all
 * three. Newlines are preserved so line numbers survive.
 *
 * It is not a JavaScript parser. A regex literal containing a quote would
 * confuse it. Neither route has one, and the failure direction is a spurious
 * red build somebody reads — not a silent hole.
 */
function codeOnly(src: string): string {
  let out = '';
  let i = 0;
  type State = 'code' | 'line' | 'block' | "'" | '"' | '`';
  let state: State = 'code';

  while (i < src.length) {
    const c = src[i]!;
    const next = src[i + 1];

    if (state === 'code') {
      if (c === '/' && next === '/') {
        state = 'line';
        i += 2;
        continue;
      }
      if (c === '/' && next === '*') {
        state = 'block';
        i += 2;
        continue;
      }
      if (c === "'" || c === '"' || c === '`') {
        state = c;
        out += c;
        i++;
        continue;
      }
      out += c;
      i++;
      continue;
    }

    if (state === 'line') {
      if (c === '\n') {
        state = 'code';
        out += c;
      }
      i++;
      continue;
    }

    if (state === 'block') {
      if (c === '*' && next === '/') {
        state = 'code';
        i += 2;
        continue;
      }
      // Keep newlines so a reported line number still means something.
      if (c === '\n') out += c;
      i++;
      continue;
    }

    // Inside a string or template literal: keep the delimiters, blank the body.
    if (c === '\\') {
      i += 2;
      continue;
    }
    if (c === state) {
      state = 'code';
      out += c;
      i++;
      continue;
    }
    if (c === '\n') out += c;
    i++;
  }

  return out;
}

/**
 * Top-level declarations, each mapped to its own slice of the file.
 *
 * A declaration's text runs from its opening line to the line before the next
 * top-level declaration. Line-anchored on column zero rather than brace
 * matched: this file is Prettier-formatted, so every top-level declaration
 * starts at column zero — and a brace matcher is one `[]` inside a type
 * annotation away from running off the end of the file.
 */
function topLevelRegions(src: string): Map<string, string> {
  const DECL =
    /^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/;

  const lines = src.split('\n');
  const starts: Array<{ name: string; at: number }> = [];

  lines.forEach((line, i) => {
    const m = DECL.exec(line);
    if (m) starts.push({ name: m[1]!, at: i });
  });

  const regions = new Map<string, string>();
  starts.forEach(({ name, at }, i) => {
    const end = i + 1 < starts.length ? starts[i + 1]!.at : lines.length;
    regions.set(name, lines.slice(at, end).join('\n'));
  });

  return regions;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The code an exported verb can actually reach, following identifiers.
 *
 * `export const GET = defineV1Route(handler)` names `handler`, which names
 * whatever it calls. Four hops is well past anything a route file does and
 * stops a mutual reference from spinning.
 */
function reachableFrom(regions: Map<string, string>, entry: string, depth = 4): string {
  const seen = new Set<string>();
  const collected: string[] = [];
  let frontier = [entry];

  for (let d = 0; d < depth && frontier.length > 0; d++) {
    const next: string[] = [];

    for (const name of frontier) {
      if (seen.has(name)) continue;
      seen.add(name);

      const text = regions.get(name);
      if (text === undefined) continue;
      collected.push(text);

      for (const other of regions.keys()) {
        if (other === name || seen.has(other)) continue;
        if (new RegExp(`\\b${escape(other)}\\b`).test(text)) next.push(other);
      }
    }

    frontier = next;
  }

  return collected.join('\n');
}

/**
 * Which declaration a mounted verb starts from.
 *
 * `export { handler as GET }` mounts GET while declaring nothing called GET,
 * so the re-export has to be read before falling back to the verb's own name.
 */
function entryFor(src: string, method: string): string {
  const aliased = new RegExp(
    `export\\s*\\{[^}]*?\\b(\\w+)\\s+as\\s+${method}\\b[^}]*?\\}`,
    's',
  ).exec(src);
  return aliased?.[1] ?? method;
}

const routes = globSync(`${PLATFORM_TREE}**/route.ts`).map((f) => f.toString());

/**
 * Every (file, verb) pair mounted under the platform tree.
 *
 * Read from the STRIPPED source, like every other check here. On raw source a
 * commented-out `// export const DELETE = …` is detected as mounted, and the
 * resolver then finds no declaration for it and fails the build for a verb that
 * does not exist. Wrong in the safe direction, but wrong.
 */
const mounted: Array<[string, string]> = routes.flatMap((file) => {
  const code = codeOnly(readFileSync(file, 'utf8'));
  return METHODS.filter((m) => exportsMethod(code, m)).map((m) => [file, m] as [string, string]);
});

describe('platform route discipline', () => {
  it('found platform routes and the verbs they mount', () => {
    // ═══ THE VACUITY GUARD ═══
    //
    // Every assertion in this file is a `for` over a list. A glob that matched
    // nothing — a moved directory, a renamed tree — makes all of them pass
    // while checking nothing, and the suite goes green on the day the thing it
    // guards stops being guarded.
    expect(routes.length).toBeGreaterThanOrEqual(2);
    expect(mounted.length).toBeGreaterThanOrEqual(2);
  });

  it.each(routes)('%s mounts a verb this suite can see', (file) => {
    // ═══ THE OTHER WAY TO CHECK NOTHING ═══
    //
    // Everything below iterates `mounted`, which comes from `exportsMethod`.
    // That helper documents its own imprecision and recognises
    // `export const|function GET` and `export { … GET … }` — not
    // `export const { GET } = handlers`, not `export let GET`, not the second
    // declarator of `export const GET = a, DELETE = b`. Next mounts all three.
    //
    // A route written that way contributes zero pairs, so it is never checked
    // for reaching the binding and the suite stays green. The vacuity guard
    // above does not catch it either: the OTHER route still supplies pairs.
    const code = codeOnly(readFileSync(file, 'utf8'));
    const found = METHODS.filter((m) => exportsMethod(code, m));

    if (found.length === 0) {
      throw new Error(
        `${file} exports no HTTP verb that this suite can recognise.\n\n` +
          `Either it mounts nothing — in which case it is not a route and should not be\n` +
          `named route.ts — or it mounts one in a form exportsMethod cannot parse, and\n` +
          `every other check in this file is silently skipping it.\n\n` +
          `Write the export as \`export const GET = defineV1Route(handler)\`, which is how\n` +
          `every other v1 route does it.`,
      );
    }
  });

  it.each(mounted)('%s mounts %s through asPlatformAdmin', (file, method) => {
    const code = codeOnly(readFileSync(file, 'utf8'));
    const reached = reachableFrom(topLevelRegions(code), entryFor(code, method));

    if (!/\basPlatformAdmin\b/.test(reached)) {
      throw new Error(
        `${method} ${file} does not reach asPlatformAdmin.\n\n` +
          `Every verb under ${PLATFORM_TREE} crosses club boundaries by definition, and\n` +
          `asPlatformAdmin is what makes that answerable afterwards: it cannot run without\n` +
          `a live grant, the capability the action names, and an append-only row saying who\n` +
          `looked and why.\n\n` +
          `If this verb genuinely touches no club but the caller's own, it does not belong\n` +
          `under the platform tree.`,
      );
    }
  });

  it.each(routes)('%s sets platformRoute: true on EVERY context it builds', (file) => {
    const code = codeOnly(readFileSync(file, 'utf8'));

    // ═══ PER CALL, NOT PER FILE ═══
    //
    // A file-level check passes a route with two handlers where only one sets
    // the flag — and the one that forgot refuses every request from a
    // legitimate admin, silently, because asPlatformAdmin sees an empty
    // appPermissions. Counting is crude and it closes exactly that gap.
    const contexts = code.match(/contextFromRequest\s*\(/g)?.length ?? 0;
    const flagged = code.match(/platformRoute:\s*true/g)?.length ?? 0;

    if (contexts > 0 && flagged < contexts) {
      throw new Error(
        `${file} calls contextFromRequest ${contexts} time(s) but passes platformRoute: true ` +
          `${flagged} time(s).\n\n` +
          `A context built without the flag resolves no grant, so asPlatformAdmin refuses ` +
          `every caller — including an admin holding a live one. It fails closed, and it ` +
          `presents as "platform admin is broken", which is the kind of bug somebody fixes ` +
          `by reaching for asSuperuser.`,
      );
    }

    if (!/platformRoute:\s*true/.test(code)) {
      throw new Error(
        `${file} does not pass platformRoute: true to contextFromRequest.\n\n` +
          `Without it the grant is never looked up: ctx.appPermissions stays empty and\n` +
          `asPlatformAdmin throws MissingPlatformGrantError for every caller, including a\n` +
          `legitimate admin holding a live grant.\n\n` +
          `That is fail-closed, so nothing leaks — but it presents as "platform admin is\n` +
          `broken", which is the kind of bug somebody fixes by reaching for asSuperuser.`,
      );
    }
  });

  it.each(routes)('%s does not reach for an unaudited binding', (file) => {
    const code = codeOnly(readFileSync(file, 'utf8'));

    if (UNAUDITED.test(code)) {
      throw new Error(
        `${file} uses asSuperuser / runAsSuperuser.\n\n` +
          `That reaches every club exactly as asPlatformAdmin does, and leaves no record of\n` +
          `who looked or why. Under the platform tree the caller is a PERSON reaching into\n` +
          `clubs that are not theirs — the one case the audited binding exists for.`,
      );
    }
  });

  it.each(routes)('%s does not mix in a tenant binding', (file) => {
    const code = codeOnly(readFileSync(file, 'utf8'));

    if (TENANT_BOUND.test(code)) {
      throw new Error(
        `${file} uses inTenant / runInTenantContext.\n\n` +
          `runAsPlatformAdmin REFUSES to run inside a tenant transaction — see\n` +
          `AmbientPlatformEscalationError — so this is a runtime failure waiting for the\n` +
          `first request, not merely a style point. A platform route binds one way.`,
      );
    }
  });
});

describe('the audited binding stays on the platform tree', () => {
  const sources = globSync('src/**/*.{ts,tsx}').map((f) => f.toString());

  /** Where `asPlatformAdmin` may appear outside a platform route, and why. */
  const ALLOWED_OUTSIDE: Record<string, string> = {
    'src/app/api/v1/_lib/bind.ts': 'declares it',
  };

  it('the scan found the source tree', () => {
    expect(sources.length).toBeGreaterThan(100);
  });

  it('nothing outside the platform tree calls it', () => {
    // AmbientPlatformEscalationError states it plainly: "Platform work runs on
    // its own request, from a route under /api/v1/platform, never nested in a
    // tenant handler." The database enforces the nesting half. Nothing enforced
    // the location half, so the claim was true only by coincidence.
    const callers = sources.filter(
      (f) =>
        !f.startsWith(PLATFORM_TREE) &&
        !(f in ALLOWED_OUTSIDE) &&
        /\basPlatformAdmin\b/.test(codeOnly(readFileSync(f, 'utf8'))),
    );

    if (callers.length > 0) {
      throw new Error(
        `These files call asPlatformAdmin from outside ${PLATFORM_TREE}:\n\n` +
          callers.map((f) => `  ${f}`).join('\n') +
          `\n\nCalled from a tenant handler it throws AmbientPlatformEscalationError at\n` +
          `runtime; called from a route that forgot platformRoute: true it throws\n` +
          `MissingPlatformGrantError. Both are 500s discovered by a user.\n\n` +
          `Cross-club work gets its own route under the platform tree, where this suite\n` +
          `checks the rest of the contract.`,
      );
    }
  });

  it('nothing outside the platform tree asks for a grant to be resolved', () => {
    // ═══ THE CLAIM THIS MAKES TRUE ═══
    //
    // `context.ts` justifies resolving the grant per request by saying "a
    // guardrail keeps it true by asserting platform work lives only under that
    // prefix", and `platform-admin.ts` says the same. Neither was true: the
    // suite above asserts every route IN the tree sets the flag, and nothing
    // asserted that no route outside it does.
    //
    // A slug-less route elsewhere passing `platformRoute: true` gets
    // `ctx.appPermissions` and `ctx.platformGrantId` populated on a path nobody
    // reviewed as platform work. It could then gate on `hasAppPermission` and
    // pair that with `asSuperuser` for an unaudited cross-club read — passing
    // every other check here, because it never mentions `asPlatformAdmin` and
    // is not under the tree.
    const outside = sources.filter(
      (f) =>
        !f.startsWith(PLATFORM_TREE) &&
        /platformRoute:\s*true/.test(codeOnly(readFileSync(f, 'utf8'))),
    );

    if (outside.length > 0) {
      throw new Error(
        `These files outside ${PLATFORM_TREE} ask contextFromRequest to resolve a grant:\n\n` +
          outside.map((f) => `  ${f}`).join('\n') +
          `\n\nPlatform authority is acted on under the platform tree, where this suite checks\n` +
          `the rest of the contract — the audited binding, the capability, the stated reason.\n` +
          `A grant resolved anywhere else is authority with none of that around it.`,
      );
    }
  });

  it('every allowed file still exists and still mentions it', () => {
    // A rename would otherwise leave an exemption that permits nothing while
    // hiding that the declaration moved somewhere unchecked.
    for (const file of Object.keys(ALLOWED_OUTSIDE)) {
      expect(sources).toContain(file);
      expect(readFileSync(file, 'utf8')).toMatch(/\basPlatformAdmin\b/);
    }
  });
});

// ═══ NEGATIVE CONTROLS ═══
//
// Every suite above passes by finding nothing. That is indistinguishable from a
// resolver that returns "" and a regex that matches nothing — which is what
// this becomes the day somebody simplifies it. So the machinery is exercised on
// code with known answers.
describe('the detectors fire', () => {
  const ROUTE = [
    "import { asPlatformAdmin } from '@/app/api/v1/_lib/bind';",
    '',
    'const PAGE_SIZE = 50;',
    '',
    'async function handler(req: NextRequest) {',
    '  const ctx = await contextFromRequest(req, { platformRoute: true });',
    '  return asPlatformAdmin(ctx, act, (db) => db.venueOrg.findMany());',
    '}',
    '',
    'async function deleteHandler(req: NextRequest) {',
    '  return NextResponse.json({ ok: true });',
    '}',
    '',
    'export const GET = defineV1Route(handler);',
    'export const DELETE = defineV1Route(deleteHandler);',
  ].join('\n');

  it('follows an indirected verb to its binding', () => {
    const reached = reachableFrom(topLevelRegions(ROUTE), entryFor(ROUTE, 'GET'));
    expect(reached).toMatch(/\basPlatformAdmin\b/);
  });

  it('does NOT credit a second verb with the first one’s binding', () => {
    // The whole reason this resolves handlers instead of scanning the file: the
    // text above contains `asPlatformAdmin`, so a file-level check passes DELETE.
    expect(/\basPlatformAdmin\b/.test(ROUTE)).toBe(true);

    const reached = reachableFrom(topLevelRegions(ROUTE), entryFor(ROUTE, 'DELETE'));
    expect(reached).not.toMatch(/\basPlatformAdmin\b/);
  });

  it('resolves a re-exported alias to the declaration behind it', () => {
    const src = [
      'async function handler(req) {',
      '  return asPlatformAdmin(ctx, act, (db) => db.venueOrg.findMany());',
      '}',
      '',
      'export { handler as GET };',
    ].join('\n');

    expect(entryFor(src, 'GET')).toBe('handler');
    expect(reachableFrom(topLevelRegions(src), entryFor(src, 'GET'))).toMatch(
      /\basPlatformAdmin\b/,
    );
  });

  it('reads code, not the prose that explains it', () => {
    // Both live routes argue at length about why they avoid asSuperuser. If
    // that argument read as the violation, the suite would fail on the files it
    // is meant to bless.
    const docblock = [
      '/**',
      ' * Why not asSuperuser, which would also work?',
      ' */',
      'export const GET = 1;',
    ].join('\n');
    expect(UNAUDITED.test(codeOnly(docblock))).toBe(false);
    expect(UNAUDITED.test(codeOnly('// asSuperuser would reach the same rows.'))).toBe(false);
    expect(
      UNAUDITED.test(codeOnly('  return asSuperuser(ctx, (db) => db.venue.findMany());')),
    ).toBe(true);

    // …and the inverse, which is the one that actually hides a regression: a
    // docblock describing a call that has been deleted.
    const gutted = ['/**', ' * Uses asPlatformAdmin, honest.', ' */', 'export const GET = 1;'].join(
      '\n',
    );
    expect(/\basPlatformAdmin\b/.test(gutted)).toBe(true);
    expect(/\basPlatformAdmin\b/.test(codeOnly(gutted))).toBe(false);
  });

  it('is not fooled by a TRAILING comment or a string literal', () => {
    // ═══ THE HOLE THE LINE-FILTER VERSION HAD ═══
    //
    // It dropped a line only when the TRIMMED line began with a comment marker.
    // Both of these therefore satisfied the central assertion for a route that
    // never calls the binding — the second being the realistic one, since a
    // route reaching cross-club data through a helper would plausibly explain
    // itself exactly like this.
    const trailing = 'return everyClubsRevenue(ctx); // asPlatformAdmin runs inside the use case';
    const literal = "throw new Error('asPlatformAdmin requires a signed-in caller');";

    expect(/\basPlatformAdmin\b/.test(trailing)).toBe(true);
    expect(/\basPlatformAdmin\b/.test(codeOnly(trailing))).toBe(false);

    expect(/\basPlatformAdmin\b/.test(literal)).toBe(true);
    expect(/\basPlatformAdmin\b/.test(codeOnly(literal))).toBe(false);

    // A `//` INSIDE a string is not a comment, and blanking the string first is
    // what keeps that from eating the rest of the line.
    expect(codeOnly("const u = 'https://x/y'; return asPlatformAdmin(ctx);")).toMatch(
      /\basPlatformAdmin\b/,
    );

    // Template literals too, and an escaped quote must not end the string early.
    expect(/\basPlatformAdmin\b/.test(codeOnly('const s = `asPlatformAdmin`;'))).toBe(false);
    expect(/\basPlatformAdmin\b/.test(codeOnly("const s = 'it\\'s asPlatformAdmin';"))).toBe(false);

    // And the real call still reads as one when it sits beside all of that.
    const mixed = [
      "const label = 'asPlatformAdmin';  // asPlatformAdmin",
      'return asPlatformAdmin(ctx, act, (db) => db.venueOrg.findMany());',
    ].join('\n');
    expect(/\basPlatformAdmin\b/.test(codeOnly(mixed))).toBe(true);
  });

  it('keeps line count stable, so a reported line number still means something', () => {
    const src = ['/**', ' * doc', ' */', 'const a = 1; // tail', "const b = 'x';"].join('\n');
    expect(codeOnly(src).split('\n')).toHaveLength(src.split('\n').length);
  });

  it('sees platformRoute only when it is set to true', () => {
    expect(/platformRoute:\s*true/.test('  const ctx = await contextFromRequest(req, {')).toBe(
      false,
    );
    expect(/platformRoute:\s*true/.test('    platformRoute: true,')).toBe(true);
    // The near-miss: a flag that is present and off.
    expect(/platformRoute:\s*true/.test('    platformRoute: false,')).toBe(false);
  });

  it('the tenant-binding detector distinguishes a call from an unrelated word', () => {
    expect(TENANT_BOUND.test('return inTenant(ctx, (db) => db.booking.findMany());')).toBe(true);
    expect(TENANT_BOUND.test('const subjectTenantId = null;')).toBe(false);
  });
});

/**
 * THE PLATFORM API IS DOCUMENTED AND NOT SHIPPED TO THE PHONE.
 *
 * The owner's decision: describe it in the spec — an undocumented privileged
 * API is worse than a documented one — and keep it out of the generated Swift
 * client, because the phone has no business calling it.
 *
 * Both halves are one edit from quietly reversing, in opposite directions:
 *
 *   a platform operation without the `Platform` tag lands IN the client
 *   a new feature area not added to the filter silently drops OUT of it
 *
 * `swift-openapi-generator` has no `excludeTags`. The filter is an include-list,
 * so the second failure is the likelier one and it is invisible — the endpoint
 * ships, the client has no method for it, and nobody finds out until somebody
 * tries to call it.
 */
describe('the client filter matches the spec', () => {
  interface Op {
    tags?: string[];
  }
  const spec = JSON.parse(readFileSync('openapi/playerz-v1.json', 'utf8')) as {
    tags?: Array<{ name: string; description?: string }>;
    paths: Record<string, Record<string, Op>>;
  };

  /** Tags the README deliberately keeps out of the generated client. */
  const EXCLUDED = ['Platform', 'Internal'];

  const specMethods = ['get', 'post', 'put', 'patch', 'delete'];

  const operations = Object.entries(spec.paths).flatMap(([path, ops]) =>
    Object.entries(ops)
      .filter(([m]) => specMethods.includes(m))
      .map(([m, op]) => ({ path, method: m.toUpperCase(), tags: op.tags ?? [] })),
  );

  /** The `filter.tags:` list from the generator config in openapi/README.md. */
  const filterTags = (() => {
    const readme = readFileSync('openapi/README.md', 'utf8');
    const block = /filter:\n {2}tags:\n((?: {4}- \w+\n)+)/.exec(readme);
    return block ? [...block[1]!.matchAll(/- (\w+)/g)].map((m) => m[1]!) : [];
  })();

  it('found the spec, its operations and the README filter', () => {
    // Three separate ways for this suite to go vacuously green: an empty spec,
    // a regex that stops matching the README, or operations with no tags.
    expect(operations.length).toBeGreaterThanOrEqual(15);
    expect(spec.tags?.length ?? 0).toBeGreaterThanOrEqual(5);
    expect(filterTags.length).toBeGreaterThanOrEqual(5);
  });

  it('every platform operation carries the Platform tag, and only those', () => {
    const wrong = operations
      .filter((o) => o.path.startsWith('/platform/') !== o.tags.includes('Platform'))
      .map((o) => `${o.method} ${o.path} [${o.tags.join(', ') || 'untagged'}]`);

    if (wrong.length > 0) {
      throw new Error(
        `Tag and path disagree about what is platform authority:\n\n` +
          wrong.map((w) => `  ${w}`).join('\n') +
          `\n\nThe tag is what keeps these out of the generated Swift client — see the\n` +
          `filter in openapi/README.md. A platform operation missing it ships a method\n` +
          `for cross-club administration in the phone binary.`,
      );
    }
  });

  it('every operation is tagged at all', () => {
    // An untagged operation is excluded by an include-list filter without ever
    // being decided about.
    const untagged = operations
      .filter((o) => o.tags.length === 0)
      .map((o) => `${o.method} ${o.path}`);
    expect(untagged).toEqual([]);
  });

  it('every tag is either generated or deliberately excluded', () => {
    const declared = (spec.tags ?? []).map((t) => t.name);
    const accounted = new Set([...filterTags, ...EXCLUDED]);

    const unaccounted = declared.filter((t) => !accounted.has(t));
    if (unaccounted.length > 0) {
      throw new Error(
        `These spec tags appear in neither the client filter nor the exclusion list:\n\n` +
          unaccounted.map((t) => `  ${t}`).join('\n') +
          `\n\nswift-openapi-generator's filter is an INCLUDE-list, so the effect is that the\n` +
          `generated client silently has no methods for them. Add each one to filter.tags\n` +
          `in openapi/README.md, or to EXCLUDED here with the reason in the README.`,
      );
    }

    // And the other way: a filter entry for a tag that no longer exists stops
    // filtering anything and hides that the operations moved.
    expect(filterTags.filter((t) => !declared.includes(t))).toEqual([]);
  });

  it('no operation escapes exclusion by ALSO carrying an included tag', () => {
    // ═══ THE FILTER IS A UNION, NOT AN INTERSECTION ═══
    //
    // swift-openapi-generator's `filter.tags` includes an operation if it
    // matches ANY listed tag. `POST /realtime/subscribe` is tagged
    // `["Realtime", "Internal"]`, and `Realtime` is in the filter — so marking
    // it `Internal` excludes nothing and the Centrifugo proxy ships in the
    // client anyway.
    //
    // Checking that `Internal` is absent from the filter list, which the test
    // below does, passes happily while that is true. Exclusion is a property of
    // the OPERATION's full tag set, not of a tag name.
    const leaking = operations
      .filter((o) => o.tags.some((t) => EXCLUDED.includes(t)))
      .filter((o) => o.tags.some((t) => filterTags.includes(t)))
      .map((o) => `${o.method} ${o.path} [${o.tags.join(', ')}]`);

    if (leaking.length > 0) {
      throw new Error(
        `These operations are marked for exclusion and generated anyway:\n\n` +
          leaking.map((l) => `  ${l}`).join('\n') +
          `\n\nfilter.tags is an include-list evaluated as a UNION: one listed tag is enough.\n` +
          `Give an excluded operation ONLY excluded tags, or accept that it ships and take\n` +
          `it off the exclusion list — but do not leave the README claiming otherwise.`,
      );
    }
  });

  it('every excluded tag is argued for in the README', () => {
    // EXCLUDED lives in this file, so adding a name to it is a one-line way to
    // drop a whole feature area out of the client with nothing written down.
    // The README is where the reasoning belongs; this makes it compulsory.
    const readme = readFileSync('openapi/README.md', 'utf8');

    const undocumented = EXCLUDED.filter((t) => !readme.includes(`\`${t}\``));
    expect(undocumented).toEqual([]);
  });

  it('the excluded tags are excluded, not merely absent', () => {
    // If `Platform` ever appeared in the filter list, every assertion above
    // would still pass — it would be "accounted for".
    for (const tag of EXCLUDED) expect(filterTags).not.toContain(tag);
  });

  it('every declared tag says what it is', () => {
    // A tag with no description is one the next person cannot decide about.
    const bare = (spec.tags ?? [])
      .filter((t) => (t.description ?? '').length < 20)
      .map((t) => t.name);
    expect(bare).toEqual([]);
  });

  it('the Platform tag warns that it is not in the client', () => {
    // The spec is read on its own, without this README beside it.
    const platform = (spec.tags ?? []).find((t) => t.name === 'Platform');
    expect(platform?.description).toMatch(/EXCLUDED from the generated client/);
  });
});
