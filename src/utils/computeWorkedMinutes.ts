// Shared by closeAssignmentAutomatically (auto-close / back-to-back
// discovery), reviewAssignmentOvertime's correct_finish_time decision, and
// the resolve-break action — every place that turns a checked-in/checked-out
// span plus a breaks array into payroll minutes, so the three call sites
// can never quietly disagree with each other.
//
// A break missing endedAt is never fabricated an end time and never
// subtracted as unpaid: either guess silently discards potentially-worked,
// potentially-billable time with no review path. The ambiguous span stays
// counted as worked, flowing into actualMinutes/overtimeMinutes where the
// mandatory overtimeStatus "pending" review is what actually governs
// manager visibility.
export interface WorkedMinutesBreak {
  startedAt?: Date | string | null;
  endedAt?: Date | string | null;
}

export interface WorkedMinutesResult {
  actualMinutes: number;
  overtimeMinutes: number;
  approvedMinutes: number;
  hadOpenBreak: boolean;
}

export function computeWorkedMinutes(
  checkedInAt: Date,
  checkedOutAt: Date,
  breaks: WorkedMinutesBreak[] | null | undefined,
  jobMinutes: number
): WorkedMinutesResult {
  let hadOpenBreak = false;
  const breakMinutes = (breaks ?? []).reduce((sum, b) => {
    if (b.endedAt) {
      return sum + Math.round((new Date(b.endedAt).getTime() - new Date(b.startedAt!).getTime()) / 60_000);
    }
    hadOpenBreak = true;
    return sum; // ambiguous span stays counted as worked, never discarded as unpaid
  }, 0);

  const grossMinutes = Math.round((checkedOutAt.getTime() - checkedInAt.getTime()) / 60_000);
  const actualMinutes = Math.max(0, grossMinutes - breakMinutes);
  const overtimeMinutes = Math.max(0, actualMinutes - jobMinutes);
  const approvedMinutes = actualMinutes - overtimeMinutes;

  return { actualMinutes, overtimeMinutes, approvedMinutes, hadOpenBreak };
}
