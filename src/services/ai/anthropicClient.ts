import Anthropic from "@anthropic-ai/sdk";

// Lazy singleton — constructed on first use, not at import time, so the
// server can boot (and every other route can work) even when
// ANTHROPIC_API_KEY hasn't been configured yet. The AI routes are the only
// thing that fails, and only when actually called.
let client: Anthropic | null = null;

export function getAnthropicClient(): Anthropic {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error(
      "ANTHROPIC_API_KEY is not configured — add it to the server .env to enable AI features."
    );
  }
  if (!client) {
    client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return client;
}
