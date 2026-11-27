// Assignment statuses that mean a worker is covering the shift: they've
// accepted it, are on it now, or have finished it. Used by the
// "unfilled shift" alerts so a worker who clocks in early doesn't make
// the shift look unstaffed.
export const STAFFED_STATUSES = ["accepted", "in-progress", "completed"] as ("accepted" | "in-progress" | "completed")[];
