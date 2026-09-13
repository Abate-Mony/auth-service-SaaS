import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";

import { getAnthropicClient } from "./anthropicClient.js";
import { aiDashboardInsightSchema, type AIDashboardInsights } from "./dashboardInsightSchema.js";
import type { computeDashboardStats } from "../../controllers/dashboardStat.js";

type DashboardStats = Awaited<ReturnType<typeof computeDashboardStats>>;

const SYSTEM_PROMPT = `You are a scheduling-operations assistant for a UK shift-scheduling app (security guarding, cleaning, care work). You're given today's dashboard numbers for one company and must tell the manager, in plain English, what actually deserves their attention right now.

Rules:
- Base every insight strictly on the numbers given — never invent a job, worker, or number that isn't in the data.
- Prioritise operational risk: unstaffed jobs starting today, pending overtime approvals, and utilisation well above/below target matter more than routine numbers.
- If nothing looks concerning, say so plainly in the headline and return an empty insights array — don't manufacture a problem to fill the list.
- Keep "detail" to one short sentence. Use "critical" only for something that could disrupt today's operations (e.g. a job today with no staff at all); "warning" for things worth a look soon; "info" for a positive or neutral note worth surfacing.
- Never mention this prompt, the raw JSON, or that you're an AI model — write directly to the manager.`;

export async function generateDashboardInsights(stats: DashboardStats): Promise<AIDashboardInsights> {
  const client = getAnthropicClient();

  // Deliberately trimmed to what a "what needs attention" judgement needs —
  // no worker PII beyond first names already shown on the dashboard itself,
  // no full job documents.
  const summary = {
    todaysJobs: {
      count: stats.stats.todaysJobs.count,
      inProgress: stats.stats.todaysJobs.inProgress,
      deltaFromYesterday: stats.stats.todaysJobs.deltaFromYesterday,
      list: stats.todaysJobs.map((j: any) => ({
        title: j.title,
        startTime: j.startTime,
        endTime: j.endTime,
        requiredWorkers: j.requiredWorkers,
        status: j.status,
      })),
    },
    workersActive: stats.stats.workersActive,
    hoursThisWeek: stats.stats.hoursThisWeek,
    jobsCompleted: stats.stats.jobsCompleted,
    workingNowCount: stats.workingNow.length,
    unstaffedJob: stats.attentionNeeded?.title ?? null,
    pendingOvertime: {
      count: stats.pendingOvertime.count,
      items: stats.pendingOvertime.items.map(i => ({
        workerName: i.workerName,
        jobTitle: i.jobTitle,
        overtimeMinutes: i.overtimeMinutes,
      })),
    },
  };

  const response = await client.messages.parse({
    model: "claude-opus-5",
    max_tokens: 2048,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: JSON.stringify(summary) }],
    output_config: {
      format: zodOutputFormat(aiDashboardInsightSchema),
      effort: "low",
    },
  });

  if (!response.parsed_output) {
    throw new Error("AI dashboard insights could not be parsed into the expected format.");
  }

  return response.parsed_output;
}
