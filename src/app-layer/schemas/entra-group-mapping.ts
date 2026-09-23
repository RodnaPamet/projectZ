import { z } from 'zod';

/**
 * Validation for Entra group → role mappings.
 *
 * ═══ OWNER IS NOT IN THE MAPPABLE SET ═══
 *
 * Every Role except OWNER. That is a product decision, not an oversight, and
 * it is worth stating because the obvious "all roles" version looks more
 * complete:
 *
 * OWNER carries `admin.tenant_lifecycle` (suspend or close the club) and
 * `admin.owner_management` (change who owns it). A mapping that granted it
 * would make club ownership transferable by editing an Active Directory group
 * — by directory administrators, outside this application, who have no way of
 * knowing what the role means here.
 *
 * The same refusal is repeated in the use case, in the sync's OWNER-immunity
 * check, and as a CHECK constraint in P27. Three of those four are one careless
 * edit from disappearing, which is why there are four.
 */

/** Every Role the schema defines, except OWNER. */
export const ENTRA_MAPPABLE_ROLES = ['MANAGER', 'COACH', 'STAFF', 'PLAYER'] as const;
export type EntraMappableRole = (typeof ENTRA_MAPPABLE_ROLES)[number];

/**
 * Priority is admin-set, not derived from role seniority.
 *
 * A club may deliberately want a narrow group to beat a broad one — "everyone"
 * maps to PLAYER at 0, "coaching staff" to COACH at 100. Inferring precedence
 * from the roles themselves would make that unexpressible.
 */
const priority = z.number().int().min(0).max(1000);

export const EntraGroupMappingCreateSchema = z.object({
  /**
   * An Entra security-group object id. Validated as a UUID because that is
   * what Entra issues — a display name here would silently never match any
   * `groups` claim, and the mapping would look configured while doing nothing.
   */
  //
  // Lower-cased on the way in. Entra emits GUIDs in lower case, but an admin
  // pasting one from a portal that upper-cases it would store a value that
  // never matches any claim — a mapping that looks configured and silently
  // grants nothing.
  aadGroupId: z
    .string()
    .uuid()
    .transform((v) => v.toLowerCase()),
  /** Cached Graph display name; cosmetics only, never matched on. */
  aadGroupName: z.string().trim().min(1).max(256).optional(),
  role: z.enum(ENTRA_MAPPABLE_ROLES),
  priority: priority.default(0),
});

export const EntraGroupMappingUpdateSchema = z
  .object({
    aadGroupName: z.string().trim().min(1).max(256).optional(),
    role: z.enum(ENTRA_MAPPABLE_ROLES).optional(),
    priority: priority.optional(),
  })
  // An empty PATCH is a client bug. Accepting it would return 200 and change
  // nothing, which reads as success.
  .refine((v) => Object.values(v).some((x) => x !== undefined), {
    message: 'At least one field must be provided',
  });

export type EntraGroupMappingCreate = z.infer<typeof EntraGroupMappingCreateSchema>;
export type EntraGroupMappingUpdate = z.infer<typeof EntraGroupMappingUpdateSchema>;
