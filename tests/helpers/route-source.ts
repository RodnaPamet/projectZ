/**
 * Reading a route file as CODE, and following an exported verb to what it calls.
 *
 * ONE definition, for the same reason `route-exports.ts` exists: these were
 * written for `platform-route-discipline`, and the second guardrail that needed
 * them (`tenant-routes-resolve-membership`, #250) would otherwise have pasted
 * them — which is how one copy gets fixed and the other does not.
 *
 * The prose below was written for the platform tree and still says so. It is
 * about the technique, which is the same wherever it is used.
 */

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
export function codeOnly(src: string): string {
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
export function topLevelRegions(src: string): Map<string, string> {
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
export function reachableFrom(regions: Map<string, string>, entry: string, depth = 4): string {
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
export function entryFor(src: string, method: string): string {
  const aliased = new RegExp(
    `export\\s*\\{[^}]*?\\b(\\w+)\\s+as\\s+${method}\\b[^}]*?\\}`,
    's',
  ).exec(src);
  return aliased?.[1] ?? method;
}
