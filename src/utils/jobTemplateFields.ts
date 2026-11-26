// Which job fields a template carries, and how to copy them off an existing
// job. Pure, so it's unit-tested (tests/job-templates.test.cjs).

export const TEMPLATE_JOB_FIELDS = [
    "title", "description", "priority", "startTime", "endTime", "requiredWorkers",
    "payRate", "chargeType", "chargeRate", "chargeAmount", "instructions", "notes",
    "checklist", "openToClaims", "requiresApproval", "autoAccept",
] as const;

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * The reusable part of a job — never its client, site, date, workers,
 * status, invoice or anything that happened on the day. Checklist items
 * come back unticked (text only).
 */
export function templateFieldsFromJob(job: Record<string, any>) {
    const time = (t: unknown) => (typeof t === "string" && HHMM.test(t) ? t : "");
    const chargeType: "hourly" | "fixed" = job.chargeType === "fixed" ? "fixed" : "hourly";
    return {
        title: String(job.title ?? "").slice(0, 200),
        description: String(job.description ?? ""),
        priority: ((["low", "medium", "high", "urgent"] as const).includes(job.priority) ? job.priority : "medium") as "low" | "medium" | "high" | "urgent",
        startTime: time(job.startTime),
        endTime: time(job.endTime),
        requiredWorkers: Math.min(50, Math.max(1, Number(job.requiredWorkers) || 1)),
        payRate: Math.max(0, Number(job.payRate) || 0),
        chargeType,
        chargeRate: chargeType === "hourly" ? Math.max(0, Number(job.chargeRate) || 0) : 0,
        chargeAmount: chargeType === "fixed" ? Math.max(0, Number(job.chargeAmount) || 0) : 0,
        instructions: String(job.instructions ?? ""),
        notes: String(job.notes ?? ""),
        checklist: (Array.isArray(job.checklist) ? job.checklist : [])
            .map((i: any) => ({ text: String(i?.text ?? "").trim().slice(0, 200) }))
            .filter((i: { text: string }) => i.text),
        openToClaims: !!job.openToClaims,
        requiresApproval: job.requiresApproval !== false,
        autoAccept: !!job.autoAccept,
    };
}

/** Sort for the picker: most used first, then recently used, then A–Z. */
export function compareTemplates(
    a: { useCount?: number; lastUsedAt?: Date | string | null; name: string },
    b: { useCount?: number; lastUsedAt?: Date | string | null; name: string },
) {
    return (b.useCount ?? 0) - (a.useCount ?? 0)
        || (b.lastUsedAt ? new Date(b.lastUsedAt).getTime() : 0) - (a.lastUsedAt ? new Date(a.lastUsedAt).getTime() : 0)
        || a.name.localeCompare(b.name);
}
