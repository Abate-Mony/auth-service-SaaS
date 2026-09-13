import type { Request, Response } from "express";
import { StatusCodes } from "http-status-codes";
import { z } from "zod";
import dayjs from "dayjs";

import Client from "../models/clientModel.js";
import { BadRequestError } from "../errors/customErrors.js";
import { generateJobDraft } from "../services/ai/jobDraftAssistant.js";
import { generateDashboardInsights } from "../services/ai/dashboardInsightAssistant.js";
import { assertFeatureEnabledForCompany } from "../utils/planLimits.js";
import { computeDashboardStats } from "./dashboardStat.js";

const generateJobDraftRequestSchema = z
  .object({
    prompt: z.string().trim().min(3, "Describe the shift in a bit more detail.").max(1000),
  })
  .strict();

// AI never writes to the database and never returns a client id it invented —
// it only ever names a client from the company's real list, matched here
// server-side. The manager reviews and edits the draft in the normal
// CreateJob wizard before anything is saved; nothing here is auto-submitted.
export const generateJobDraftHandler = async (req: Request, res: Response) => {
  const parsed = generateJobDraftRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    throw new BadRequestError(parsed.error.issues[0]?.message ?? "Invalid request.");
  }

  const companyId = req.user!.company_id;
  await assertFeatureEnabledForCompany(companyId, "aiJobAssistant");

  const clients = await Client.find({ company: companyId, isDeleted: false, status: "active" })
    .select("name")
    .lean();
  const clientNames = clients.map(c => c.name);

  const draft = await generateJobDraft({
    prompt: parsed.data.prompt,
    clientNames,
    today: dayjs().format("YYYY-MM-DD"),
  });

  let matchedClient: { id: string; name: string } | null = null;
  let unmatchedClientName: string | null = null;
  if (draft.clientName) {
    const exact = clients.find(c => c.name.toLowerCase() === draft.clientName!.toLowerCase());
    const partial =
      exact ??
      clients.find(
        c =>
          c.name.toLowerCase().includes(draft.clientName!.toLowerCase()) ||
          draft.clientName!.toLowerCase().includes(c.name.toLowerCase())
      );
    if (partial) {
      matchedClient = { id: partial._id.toString(), name: partial.name };
    } else {
      unmatchedClientName = draft.clientName;
    }
  }

  res.status(StatusCodes.OK).json({ draft, matchedClient, unmatchedClientName });
};

// Explicit, manager-triggered — never auto-runs on dashboard load. Each call
// re-queries the same numbers the dashboard already shows (computeDashboardStats)
// so the AI can't drift from what's actually on screen, then asks Claude to
// prioritise/summarise them. Purely descriptive: no field here can trigger a
// write anywhere.
export const generateDashboardInsightsHandler = async (req: Request, res: Response) => {
  const companyId = req.user!.company_id;
  await assertFeatureEnabledForCompany(companyId, "aiDashboardInsights");

  const stats = await computeDashboardStats(companyId);
  const insights = await generateDashboardInsights(stats);

  res.status(StatusCodes.OK).json(insights);
};
