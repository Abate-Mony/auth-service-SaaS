// utils/pay.ts
export interface PayBreakdown {
  workedMinutes: number
  regularMinutes: number
  overtimeMinutes: number
  totalPay: number
}

export function computePay(
  workedMinutes: number,
  payRate: number,
  opts: { overtimeThresholdMinutes?: number; overtimeMultiplier?: number } = {}
): PayBreakdown {
  const threshold = opts.overtimeThresholdMinutes ?? 8 * 60;
  const multiplier = opts.overtimeMultiplier ?? 1.5;

  const regularMinutes = Math.min(workedMinutes, threshold);
  const overtimeMinutes = Math.max(0, workedMinutes - threshold);

  const totalPay =
    (regularMinutes / 60) * payRate +
    (overtimeMinutes / 60) * payRate * multiplier;

  return {
    workedMinutes,
    regularMinutes,
    overtimeMinutes,
    totalPay: Math.round(totalPay * 100) / 100,
  };
}