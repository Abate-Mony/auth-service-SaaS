// zod/v4 — see jobDraftSchema.ts for why (zodOutputFormat() requires it).
import { z } from "zod/v4";

export const aiDashboardInsightSchema = z
  .object({
    // A single reassuring or attention-grabbing sentence for the top of the
    // widget — e.g. "Everything's on track today" or "2 things need a look".
    headline: z.string().max(200),

    insights: z
      .array(
        z
          .object({
            severity: z.enum(["info", "warning", "critical"]),
            title: z.string().max(120),
            detail: z.string().max(300),
          })
          .strict()
      )
      .max(6),
  })
  .strict();

export type AIDashboardInsights = z.infer<typeof aiDashboardInsightSchema>;
