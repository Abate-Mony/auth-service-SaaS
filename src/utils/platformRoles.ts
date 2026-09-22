// Platform-role helpers, mirroring utils/roles.ts's shape for the tenant
// `role` field. Deliberately kept as its own union/array rather than folded
// into USER_ROLES — platformRole is a completely separate authorization axis
// (INPRN staff acting on the platform itself) from a user's role inside one
// company, and the two must never be checked interchangeably.
export const PLATFORM_ROLES = ["super_admin", "support_admin", "billing_admin"] as const;
export type PlatformRole = (typeof PLATFORM_ROLES)[number];

export function isPlatformRole(value: string | undefined | null): value is PlatformRole {
  return value != null && (PLATFORM_ROLES as readonly string[]).includes(value);
}
