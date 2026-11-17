// Company health for the platform admin: a quick "is this account OK?"
// from a few signals. Pure — services/companyHealth.service.ts gathers the
// signals from the database; this decides what they mean, so it can be
// unit-tested without one.

export type HealthLevel = "healthy" | "watch" | "at_risk";

export interface HealthSignals {
  createdAt: Date;
  lastManagerLoginAt: Date | null; // latest login of any owner/admin/manager
  jobsLast30Days: number;
  activeWorkers: number;
  subscriptionStatus: string | null;
  onboarding: { firstJob: boolean; workerInvited: boolean; firstInvoice: boolean };
}

export interface CompanyHealth {
  level: HealthLevel;
  score: number; // 0–100
  reasons: string[]; // why it isn't healthy, most serious first
  signals: HealthSignals;
}

const DAY = 24 * 60 * 60 * 1000;
export const FAILING_PAYMENT_STATUSES = ["past_due", "unpaid", "incomplete", "incomplete_expired"];

export function assessHealth(signals: HealthSignals, now: Date = new Date()): CompanyHealth {
  const ageDays = (now.getTime() - new Date(signals.createdAt).getTime()) / DAY;
  const loginDays = signals.lastManagerLoginAt
    ? (now.getTime() - new Date(signals.lastManagerLoginAt).getTime()) / DAY
    : null;

  const risk: string[] = [];
  const watch: string[] = [];
  let score = 100;

  if (signals.subscriptionStatus && FAILING_PAYMENT_STATUSES.includes(signals.subscriptionStatus)) {
    risk.push(`Payment failing (${signals.subscriptionStatus.replace(/_/g, " ")})`);
    score -= 40;
  }

  if (loginDays === null) {
    if (ageDays > 7) { risk.push("No manager has ever logged in"); score -= 35; }
  } else if (loginDays > 14) {
    risk.push(`No manager login for ${Math.floor(loginDays)} days`);
    score -= 30;
  } else if (loginDays > 7) {
    watch.push(`No manager login for ${Math.floor(loginDays)} days`);
    score -= 10;
  }

  if (signals.jobsLast30Days === 0 && ageDays > 14) {
    risk.push("No jobs created in the last 30 days");
    score -= 25;
  }

  if (ageDays > 3) {
    const missing = [
      !signals.onboarding.firstJob && "first job",
      !signals.onboarding.workerInvited && "first worker",
      !signals.onboarding.firstInvoice && "first invoice",
    ].filter(Boolean) as string[];
    if (missing.length) {
      watch.push(`Onboarding not finished: no ${missing.join(", ")}`);
      score -= 5 * missing.length;
    }
  }

  const level: HealthLevel = risk.length ? "at_risk" : watch.length ? "watch" : "healthy";
  return { level, score: Math.max(0, Math.min(100, score)), reasons: [...risk, ...watch], signals };
}
