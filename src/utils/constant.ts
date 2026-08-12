export type productStatesType = "pending" | "recieve" | "sent";
export type UserroleTypes = "admin" | "user" | "moderator" | "worker";
interface IUserTypes {
  [key: string | number]: UserroleTypes;
}
interface IProductStates {
  [key: string | number]: productStatesType;
}
export const USER_ROLES: IUserTypes = {
  admin: "admin",
  user: "worker",
  moderator: "moderator",
  worker: "worker",
};
export const PRODUCT_STATES :IProductStates = {
  pending: "pending",
  recieve:"recieve",
  sent:"sent"
};
export const BUSINESS_TYPES = [
  "Cleaning Company", "Security Company", "Care Agency", "Construction",
  "Hospitality", "Warehouse", "Logistics", "Healthcare", "Retail",
  "Manufacturing", "Education", "Other",
] as const;

export const COMPANY_SIZES = [
  "1–10 workers", "11–25 workers", "26–50 workers",
  "51–100 workers", "100+",
] as const;
export const PLANS = ["free", "starter", "professional", "enterprise"] as const;
export type Plan = (typeof PLANS)[number];

export const PLAN_LIMITS: Record<Plan, number> = {
  free: 3,
  starter: 15,
  professional: 50,
  enterprise: -1, // unlimited
};
// lettinge
