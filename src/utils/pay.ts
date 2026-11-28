// utils/pay.ts
//
// Single source of truth for "regular + overtime" pay math — shared by the
// admin payroll report (reportController.ts) and a worker's own self-service
// earnings (workerController.ts's getWorkerDashboardStats). These two
// independently duplicating this arithmetic is exactly how they drifted out
// of sync: the worker-facing one silently never applied any overtime
// premium at all, so a worker's own "earnings this month" under-reported
// what the payroll report (correctly) showed their employer.
//
// Overtime here means manager-APPROVED overtime specifically
// (overtimeStatus === "approved") — anything still pending review is
// already excluded from payableMinutes (capped at the scheduled amount),
// so it isn't double-counted.
//
// overtimeMultiplier is always passed in explicitly, never defaulted here —
// it's a real per-company setting (Company.overtimeMultiplier), and a
// silent 1.5 fallback baked into this function would just reintroduce the
// same "ignores what the company actually configured" bug at one remove.
// Callers read it from the company themselves.
export interface AssignmentPayInput {
  payableMinutes: number;
  overtimeMinutes?: number | null;
  overtimeStatus?: string | null;
  payRate?: number | null;
  /** Time actually worked (after breaks). Needed to read an "adjust" correctly. */
  actualMinutes?: number | null;
}

/**
 * The overtime a manager actually allowed.
 *
 * overtimeMinutes is the extra time the worker *recorded* beyond the
 * scheduled length, and it isn't changed by the review. "Approve" pays all
 * of it, but "adjust" (pay a set number of minutes, e.g. cut 2h22 down to
 * 2h on a 1h30 job) also marks the overtime approved — so using
 * overtimeMinutes as-is reported 52 minutes of overtime when only 30 were
 * paid, mislabelling regular time as overtime (and overpaying it whenever
 * the overtime multiplier is above 1).
 *
 * The scheduled part is actualMinutes − overtimeMinutes; whatever is paid
 * beyond that is the allowed overtime, never more than what was recorded.
 */
export function approvedOvertimeMinutesOf(a: AssignmentPayInput): number {
  if (a.overtimeStatus !== "approved") return 0;
  const recorded = Math.max(0, a.overtimeMinutes ?? 0);
  if (a.actualMinutes == null) return recorded;
  const scheduled = Math.max(0, a.actualMinutes - recorded);
  return Math.min(recorded, Math.max(0, a.payableMinutes - scheduled));
}

export interface PaySplit {
  regularMinutes: number;
  overtimeMinutes: number;
  regularPay: number;
  overtimePay: number;
  totalPay: number;
}

export function splitAssignmentPay(a: AssignmentPayInput, overtimeMultiplier: number): PaySplit {
  const rate = a.payRate ?? 0;
  const overtimeMinutes = approvedOvertimeMinutesOf(a);
  const regularMinutes = Math.max(0, a.payableMinutes - overtimeMinutes);
  const regularPay = (regularMinutes / 60) * rate;
  const overtimePay = (overtimeMinutes / 60) * rate * overtimeMultiplier;

  return {
    regularMinutes,
    overtimeMinutes,
    regularPay,
    overtimePay,
    totalPay: regularPay + overtimePay,
  };
}
