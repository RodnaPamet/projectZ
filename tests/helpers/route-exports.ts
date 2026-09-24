/**
 * Which HTTP verbs a Next.js route file actually mounts.
 *
 * ONE definition, because this was pasted into two guardrails and only one of
 * them got fixed.
 *
 * Next.js honours a RE-EXPORT: `export { POST }` and `export { handler as POST }`
 * mount the route exactly as a direct declaration does. A detector matching
 * only `export const|function POST` sees nothing, and both guardrails that
 * depend on it then skip the file entirely rather than flagging it — so an
 * unguarded admin route, absent from the OpenAPI spec and from
 * ROUTE_PERMISSIONS, ships with a green build.
 *
 * KNOWN AND DELIBERATE IMPRECISION: this also matches `export { POST as handler }`
 * (which does NOT mount POST) and `export type { POST }`. Both are false
 * POSITIVES — they demand a permission rule and a spec entry for something
 * that is not mounted. For a default-deny ratchet that is the safe direction
 * to be wrong in: the cost is a spurious failure a human reads, not a silent
 * hole nobody sees.
 */
export function exportsMethod(src: string, method: string): boolean {
  const declared = new RegExp(`export\\s+(?:async\\s+)?(?:const|function)\\s+${method}\\b`).test(
    src,
  );

  // `export { POST }`, `export { POST, DELETE }`, `export { h as POST }`
  const reExported = new RegExp(
    `export\\s*\\{[^}]*?\\b(?:\\w+\\s+as\\s+)?${method}\\b[^}]*?\\}`,
    's',
  ).test(src);

  return declared || reExported;
}
