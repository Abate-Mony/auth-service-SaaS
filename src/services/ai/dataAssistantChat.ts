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
- Never mention the tool names, JSON, or that you're an AI model — just answer like a knowledgeable colleague.`;

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
