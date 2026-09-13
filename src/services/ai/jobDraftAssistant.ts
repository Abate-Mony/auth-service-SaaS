import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import dayjs from "dayjs";

import { getAnthropicClient } from "./anthropicClient.js";
import { aiJobDraftSchema, type AIJobDraft } from "./jobDraftSchema.js";

interface GenerateJobDraftParams {
  prompt: string;
  clientNames: string[];
  today: string; // YYYY-MM-DD, server-local — company timezone isn't modelled yet
}

const SYSTEM_PROMPT = `You turn a manager's short, informal description of a work shift into a structured job draft for a UK shift-scheduling app (security guarding, cleaning, or care work).

Rules:
- Today's date is {today}. Resolve relative dates ("tomorrow", "next Monday", "Friday") against it.
- Times are 24-hour "HH:mm". Dates are "YYYY-MM-DD".
- clientName: only set this if the prompt names a client/site. If it closely matches one of the company's existing clients listed below, use that client's exact name. Otherwise use the name as stated in the prompt. Never invent a client that wasn't mentioned.
- Leave a field null if the prompt gives no basis for it — do not invent specifics (rates, addresses, worker counts) that weren't stated or strongly implied.
- chargeType/chargeRate/chargeAmount describe what the CLIENT is billed, not what the worker is paid. payRate is what the worker is paid, per hour. If the prompt only gives one figure, use judgement about which it refers to and note the assumption.
- priority, chargeType, openToClaims and requiresApproval cannot be null — fall back to this app's own defaults when the prompt gives no basis: priority "medium", chargeType "hourly", openToClaims false, requiresApproval true. Only note an assumption for these if you actually fell back to the default.
- Populate "assumptions" with a short plain-English note for every field you guessed, defaulted, or left null despite it likely mattering (e.g. "No pay rate given — left blank", "Assumed this is for Tesco Extra based on \\"tesco\\""). Keep each note under one sentence. Omit assumptions for fields that were simply not relevant to the request.
- Existing clients for this company: {clients}`;

export async function generateJobDraft({
  prompt,
  clientNames,
  today,
}: GenerateJobDraftParams): Promise<AIJobDraft> {
  const client = getAnthropicClient();

  const system = SYSTEM_PROMPT.replace("{today}", today || dayjs().format("YYYY-MM-DD")).replace(
    "{clients}",
    clientNames.length ? clientNames.join(", ") : "(none on file)"
  );

  const response = await client.messages.parse({
    model: "claude-opus-5",
    max_tokens: 4096,
    system,
    messages: [{ role: "user", content: prompt }],
    output_config: {
      format: zodOutputFormat(aiJobDraftSchema),
      effort: "low",
    },
  });

  if (!response.parsed_output) {
    throw new Error("AI job draft could not be parsed into the expected format.");
  }

  return response.parsed_output;
}
