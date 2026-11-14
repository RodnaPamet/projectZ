import { EGRESS_PATTERNS } from './egress-patterns';

/**
 * Scan model-written text on its way OUT (agri-saas #2578/#2584).
 *
 * An answer is prose a model wrote from what its tools read. A secret it saw
 * and repeated, or a secret-shaped string it invented, must not reach a phone.
 * The patterns are the repo's own (`.secret-patterns`, via egress-patterns.ts).
 *
 * Returns rule NAMES only, never the matched text: the caller logs the
 * verdict, and a log line carrying the match would move the secret into the
 * log. A dirty verdict DISCARDS the answer; it is never redacted, because a
 * partly hidden credential is a credential with a hint.
 */
export interface EgressVerdict {
  readonly clean: boolean;
  readonly ruleIds: readonly string[];
}

const COMPILED: readonly { name: string; re: RegExp }[] = (() => {
  // An empty set would report every answer clean: the control silently off.
  if (EGRESS_PATTERNS.length === 0) throw new Error('egress-scan: the pattern set is empty');
  return EGRESS_PATTERNS.map((p) => {
    if (p.flags.includes('g')) throw new Error(`egress-scan: "${p.name}" carries the g flag`);
    return { name: p.name, re: new RegExp(p.source, p.flags) };
  });
})();

export const EGRESS_PATTERN_COUNT = COMPILED.length;

export function scanEgress(text: string): EgressVerdict {
  const ruleIds: string[] = [];
  for (const { name, re } of COMPILED) if (re.test(text)) ruleIds.push(name);
  return { clean: ruleIds.length === 0, ruleIds };
}
