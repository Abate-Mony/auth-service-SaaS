// A company's public quote-intake link identifier — e.g.
// quotes.onclockly.com/<slug>. Deliberately NOT an API key (see
// utils/apiKeys.ts): this value only ever resolves a company for an
// unauthenticated visitor to view a public form and submit a lead, so it
// carries none of the external-integration API key's read/write power.
// That means it's safe to store and compare in plaintext (no hash, unlike
// apiKeys.ts) and safe to rotate on request without any other credential
// being affected.
import crypto from "node:crypto";

export function generatePublicSlug(): string {
  return crypto.randomBytes(9).toString("base64url"); // 12 chars, URL-safe
}
