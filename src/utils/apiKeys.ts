// utils/apiKeys.ts
//
// Generation/hashing for external-integration API keys. The raw key is
// high-entropy (32 random bytes, base64url) and never persisted — only its
// SHA-256 hash is stored, so a database read alone can never recover a
// usable credential.
import crypto from "node:crypto";

const KEY_PREFIX = "ipk_live_";

export interface GeneratedApiKey {
  raw: string; // shown to the caller exactly once
  hash: string; // what actually gets stored
  displayPrefix: string; // safe to store/show forever, e.g. "ipk_live_aZ3f"
}

export function generateApiKey(): GeneratedApiKey {
  const secret = crypto.randomBytes(32).toString("base64url");
  const raw = `${KEY_PREFIX}${secret}`;
  return {
    raw,
    hash: hashApiKey(raw),
    displayPrefix: raw.slice(0, KEY_PREFIX.length + 6),
  };
}

export function hashApiKey(raw: string): string {
  return crypto.createHash("sha256").update(raw).digest("hex");
}

export function looksLikeApiKey(raw: string | undefined | null): raw is string {
  return typeof raw === "string" && raw.startsWith(KEY_PREFIX) && raw.length > KEY_PREFIX.length + 10;
}
