// zod/v4, not the classic "zod" import used elsewhere in this codebase —
// @anthropic-ai/sdk's zodOutputFormat() is typed against zod/v4 schemas
// specifically (see node_modules/@anthropic-ai/sdk/helpers/zod.d.ts), so a
// classic-v3 z.object() here would fail to typecheck against it.
import { z } from "zod/v4";

// What Claude is asked to produce. Deliberately a *subset* of the job form —
// staffing (workers/supervisor), geofencing and status are never AI-set;
// those stay manual, reviewed decisions. Every field is optional/nullable
// because a short prompt may simply not mention it — the frontend merges
// only what's present onto its own defaults, it never blanks a field out.
export const aiJobDraftSchema = z
  .object({
    title: z.string().min(1).max(150).nullable(),
    description: z.string().max(2000).nullable(),

    // Free text as heard in the prompt (e.g. "Tesco Extra") — the backend
    // resolves this against the company's real Client list; the model
    // never invents a client id.
    clientName: z.string().max(150).nullable(),

    // Non-nullable, with the exact same default the job form itself already
    // uses — so "the model had no basis to guess" and "the form default"
    // produce the identical value. This also keeps the schema's union/
    // nullable-field count under the API's structured-output limit (16).
    priority: z.enum(["low", "medium", "high", "urgent"]),

    date: z.string().max(10).nullable(), // YYYY-MM-DD
    startTime: z.string().max(5).nullable(), // HH:mm
    endTime: z.string().max(5).nullable(), // HH:mm

    location: z.string().max(200).nullable(),
    address: z.string().max(300).nullable(),

    requiredWorkers: z.number().int().min(1).max(500).nullable(),

    payRate: z.number().min(0).max(10000).nullable(),
    chargeType: z.enum(["hourly", "fixed"]),
    chargeRate: z.number().min(0).max(10000).nullable(),
    chargeAmount: z.number().min(0).max(1000000).nullable(),

    instructions: z.string().max(2000).nullable(),
    notes: z.string().max(2000).nullable(),

    openToClaims: z.boolean(),
    requiresApproval: z.boolean(),

    // Plain-English notes on anything the model guessed, defaulted, or
    // couldn't determine — shown to the manager so they know what to check
    // before publishing. Never used to drive behaviour.
    assumptions: z.array(z.string().max(300)).max(10),
  })
  .strict();

export type AIJobDraft = z.infer<typeof aiJobDraftSchema>;
