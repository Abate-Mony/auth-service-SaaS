// services/leadConversionService.ts
//
// Single place that turns a lead into a client. Used by the manual
// "Convert" action (leadController) and the public quote-accept flow
// (quoteController) so both paths apply the exact same rules and can't
// drift apart.
import { BadRequestError, ConflictError } from "../errors/customErrors.js";
import Client from "../models/clientModel.js";

export interface ConvertLeadOptions {
  defaultChargeType?: "hourly" | "fixed";
  defaultChargeRate?: number;
  paymentTermsDays?: number;
  billingFrequency?: "per_job" | "weekly" | "fortnightly" | "monthly" | "manual";
  billingDayOfWeek?: number;
  billingDayOfMonth?: number;
  /** Who triggered this — recorded on the lifecycleHistory entry. Omitted for the automated quote-accept path. */
  actorId?: string;
}

type ClientDoc = InstanceType<typeof Client>;

// Idempotent — calling this on an already-converted client just returns it
// unchanged, so a retried quote-accept request (or a double click on
// "Convert") can never produce inconsistent state.
export async function convertLeadToClient(
  lead: ClientDoc,
  options?: ConvertLeadOptions
): Promise<ClientDoc> {
  if (lead.lifecycle === "client") {
    return lead;
  }

  if (lead.lifecycle !== "lead") {
    throw new BadRequestError("Only an active lead can be converted to a client.");
  }

  // ClientSchema.pre("validate") reads this to label the lifecycleHistory
  // entry with who made the move — see post("init")'s counterpart that
  // captures the *previous* lifecycle onto the same $locals bag.
  if (options?.actorId) {
    (lead as any).$locals.actorId = options.actorId;
  }

  lead.lifecycle = "client";
  // The rest (status, convertedAt, leadStage/nextFollowUpAt/lostAt/
  // lostReason clearing) is handled by the model's own pre("validate")
  // hook — duplicating it here would just be two places that can drift.

  if (options?.defaultChargeType !== undefined) lead.defaultChargeType = options.defaultChargeType;
  if (options?.defaultChargeRate !== undefined) lead.defaultChargeRate = options.defaultChargeRate;
  if (options?.paymentTermsDays !== undefined) lead.paymentTermsDays = options.paymentTermsDays;
  if (options?.billingFrequency !== undefined) lead.billingFrequency = options.billingFrequency;
  if (options?.billingDayOfWeek !== undefined) lead.billingDayOfWeek = options.billingDayOfWeek;
  if (options?.billingDayOfMonth !== undefined) lead.billingDayOfMonth = options.billingDayOfMonth;

  try {
    await lead.save();
  } catch (err: any) {
    // The partial unique index only applies to lifecycle:"client" — this
    // name collides with an existing real client, which the caller needs
    // to resolve explicitly (rename or merge) rather than getting a raw 500.
    if (err?.code === 11000) {
      throw new ConflictError(
        `A client called "${lead.name}" already exists. Rename this lead before converting, or merge them manually.`
      );
    }
    throw err;
  }

  return lead;
}
