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
  const overtimeMinutes = a.overtimeStatus === "approved" ? (a.overtimeMinutes ?? 0) : 0;
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
