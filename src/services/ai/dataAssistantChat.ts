// services/ai/dataAssistantChat.ts
//
// Admin/manager "ask about our data" chat. The model never touches the
// database directly — it can only call the whitelisted, company-scoped,
// read-only tools in dataAssistantTools.ts, and every tool result is a
// hand-picked JSON object, never a raw document. See that file's header for
// the full safety model.
import { getAnthropicClient } from "./anthropicClient.js";
import { buildDataAssistantTools } from "./dataAssistantTools.js";

const SYSTEM_PROMPT = `You are a data assistant for managers/admins of a UK shift-scheduling company (security guarding, cleaning, or care work), built into their operations app.

Rules:
- You can only answer using the tools provided — call one or more of them to look up real data before answering. Never guess or invent numbers, names, or statuses.
- If a question needs data no tool can provide (e.g. worker contact details, pay rate, any personal/identifying information), say plainly that you don't have access to that rather than guessing.
- Keep answers short and direct — a sentence or two, or a brief list for multiple items. This is a chat panel, not a report.
- Amounts are in GBP. Format them naturally (e.g. "£1,240.50").
- Never mention the tool names, JSON, or that you're an AI model — just answer like a knowledgeable colleague.

Clickable references — this is important, use it every time it applies:
- Every job/invoice/quote/client/worker a tool returns carries an "id" field. Whenever your answer names ONE SPECIFIC record the manager might want to open (an unstaffed job, an overdue invoice, a client, a worker, a quote awaiting response — anything actionable or worth a closer look), wrap that mention as ⟦type:id|label⟧ instead of writing it as plain text.
  - type is exactly one of: job, invoice, quote, client, worker
  - id is the "id" field from the tool result — never invent one, never use a title/number as the id
  - label is ONLY the record's name/number as it already appears in the data (e.g. just the job title, just the invoice number, just the client name) — never pack extra detail into it (time, status, amounts); say that in the surrounding sentence instead, same as you normally would
  - Example: "⟦job:66f1a2b3c4d5e6f7a8b9c0d1|Night Shift — Bristol⟧ still has 0 of 3 workers assigned."
- Only tag specific, individually-actionable records this way — never tag a count, a summary, or a group ("7 jobs" stays plain text; naming one of those jobs gets tagged).
- Write the surrounding sentence exactly as you normally would — the tag replaces just the name/number/title being referenced, not the whole sentence.`;

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

export async function runDataAssistantChat({
  companyId,
  message,
  history,
}: {
  companyId: string;
  message: string;
  history: ChatTurn[];
}): Promise<string> {
  const client = getAnthropicClient();
  const tools = buildDataAssistantTools(companyId);

  const runner = client.beta.messages.toolRunner({
    model: "claude-sonnet-5",
    max_tokens: 1024,
    max_iterations: 6,
    system: SYSTEM_PROMPT,
    messages: [...history.map(t => ({ role: t.role, content: t.content })), { role: "user" as const, content: message }],
    tools,
  });

  const final = await runner.runUntilDone();

  const text = final.content
    .filter((block): block is Extract<typeof block, { type: "text" }> => block.type === "text")
    .map(block => block.text)
    .join("\n")
    .trim();

  return text || "I couldn't find anything relevant to answer that.";
}
