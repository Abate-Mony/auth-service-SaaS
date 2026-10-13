// Taken verbatim from the user's own client-portal spec (section 17) —
// narrowed to the actions the portal actually implements so far
// (read-only + quote accept/decline + booking:create/update/cancel for
// requests). Confirmed with the user: booking/viewer seeing bookings only
// (no quotes, no invoices) is intentional, not an oversight to loosen.
export type ClientRole = "owner" | "manager" | "booking" | "billing" | "viewer";
export type ClientAction =
  | "booking:read"
  | "booking:create"
  | "booking:update"
  | "booking:cancel"
  | "quote:read"
  | "quote:accept"
  | "invoice:read";

// booking:update/cancel are granted to the same roles that already have
// booking:create — the three booking-lifecycle actions (create/reschedule/
// cancel) travel together as one set, same as the original spec's table.
export const CLIENT_PERMISSIONS: Record<ClientRole, Set<ClientAction>> = {
  owner: new Set(["booking:read", "booking:create", "booking:update", "booking:cancel", "quote:read", "quote:accept", "invoice:read"]),
  manager: new Set(["booking:read", "booking:create", "booking:update", "booking:cancel", "quote:read", "invoice:read"]),
  booking: new Set(["booking:read", "booking:create", "booking:update", "booking:cancel"]),
  billing: new Set(["quote:read", "invoice:read"]),
  viewer: new Set(["booking:read"]),
};

// Sites aren't a resource in the original spec's table at all — tied to
// booking:read as a reasonable extension (a site only makes sense in a
// booking's context), not something literally specified.
export const canClient = (clientRole: ClientRole, action: ClientAction): boolean =>
  CLIENT_PERMISSIONS[clientRole]?.has(action) ?? false;
