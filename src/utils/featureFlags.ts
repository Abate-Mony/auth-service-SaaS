// Per-company feature flags a platform admin can switch on early for one
// company (Company.featureFlags). Keys only — what each one gates lives in
// the app. Add a key here before using it; unknown keys are refused.
export const FEATURE_FLAGS = [
  { key: "beta_features", label: "Beta features", description: "Early access to features still being tested." },
  { key: "multi_day_jobs", label: "Several-days bookings", description: "Book one job on several hand-picked days." },
  { key: "per_worker_pay_rates", label: "Per-worker pay rates", description: "Give individual workers their own rate on a job." },
  { key: "advanced_reports", label: "Advanced reports", description: "Extra reporting dashboards." },
] as const;

export type FeatureFlagKey = (typeof FEATURE_FLAGS)[number]["key"];
export const FEATURE_FLAG_KEYS = FEATURE_FLAGS.map(f => f.key) as FeatureFlagKey[];

// Internal tags platform staff can put on a company.
export const PLATFORM_TAGS = ["vip", "at_risk", "beta", "partner", "churned", "needs_follow_up"] as const;
