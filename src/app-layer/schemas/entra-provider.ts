import { z } from 'zod';

/**
 * A club's Entra configuration, as stored in
 * `TenantIdentityProvider.configJson`.
 *
 * Validated on the way OUT as well as in. A row written by an older deploy is
 * untrusted input: the shape may have changed, and a config that fails to
 * parse must degrade to "not configured" rather than throwing inside a sign-in
 * callback, where the only thing the user sees is that login is broken.
 */
export const EntraProviderConfigSchema = z.object({
  /** The club's own Entra directory tenant id — not playerz.bg's tenant id. */
  aadTenantId: z.string().uuid(),
  /** App-registration client id, used for the group-claims assignment. */
  clientId: z.string().uuid(),
  /**
   * When true, a user who matches no mapped group is denied access to this
   * club for the session.
   *
   * Off by default, and that default matters: the `groups` claim is only
   * emitted if the club configured its app registration to emit it. A club
   * that has not looks exactly like a club where nobody is in a mapped group,
   * so defaulting this on would lock out every member of every club that
   * enabled Entra before finishing the directory setup.
   */
  enforceGroupGate: z.boolean().default(false),
});

export type EntraProviderConfig = z.infer<typeof EntraProviderConfigSchema>;

/** Parse-or-null, for reading a stored configJson at runtime. */
export function parseEntraConfig(raw: unknown): EntraProviderConfig | null {
  const parsed = EntraProviderConfigSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/**
 * Read ONLY the gate flag, tolerating everything else being wrong.
 *
 * ═══ WHY THIS IS SEPARATE FROM parseEntraConfig ═══
 *
 * `parseEntraConfig` returns null on any validation failure, and a caller
 * reading `config?.enforceGroupGate` off that null sees `undefined` — which is
 * indistinguishable from the gate being deliberately off. So a corrupt
 * `aadTenantId`, a field this schema has not learned about yet, or a row
 * written by an older deploy would silently DISABLE a security control, with
 * nothing anywhere reporting it.
 *
 * A validation failure must never be the mechanism by which a restriction
 * stops applying. This reads the one field the gate decision needs and treats
 * anything non-boolean as "not set", so the rest of the config being invalid
 * cannot turn the gate off.
 */
export function readGroupGateFlag(raw: unknown): boolean {
  if (typeof raw !== 'object' || raw === null) return false;
  const value = (raw as { enforceGroupGate?: unknown }).enforceGroupGate;
  return value === true;
}
