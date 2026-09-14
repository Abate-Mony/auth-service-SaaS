// Shared role-group helpers, mirroring the frontend's utils/roles.ts.
//
// authorizePermissions (middleware/authMiddleware.ts) already gives "owner"
// every "admin" permission for route-level gating, but that hierarchy only
// applies when a route actually uses authorizePermissions — several
// controllers re-check the caller's role inline (e.g. to scope a query or
// pick email recipients, not just to 403) using a raw ["admin", "manager"]
// array that predates the owner role and silently excludes it. Use these
// instead of writing that array out again.
export const MANAGEMENT_ROLES = ["owner", "admin", "manager"] as const;
export const ADMIN_LEVEL_ROLES = ["owner", "admin"] as const;

export function isManagementRole(role: string | undefined | null): boolean {
  return role != null && (MANAGEMENT_ROLES as readonly string[]).includes(role);
}

export function isAdminLevelRole(role: string | undefined | null): boolean {
  return role != null && (ADMIN_LEVEL_ROLES as readonly string[]).includes(role);
}
