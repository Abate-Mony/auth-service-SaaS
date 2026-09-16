// utils/resendDomain.ts
//
// A thin wrapper around Resend's Domains API, normalizing its responses
// into a stable DTO the frontend depends on instead of Resend's own
// shape — see DnsRecordDto/DomainStatus. Keeps companyEmailController.ts
// free of any provider-specific field names, so switching providers later
// wouldn't touch the controller at all.
import { getResend } from "./sendMailsUtils.js";

export type DomainStatus = "not_connected" | "pending" | "verified" | "failed";

export interface DnsRecordDto {
  type: string;
  name: string;
  value: string;
  priority?: number;
  status: "pending" | "verified" | "failed";
}

const RECORD_STATUS_MAP: Record<string, "pending" | "verified" | "failed"> = {
  verified: "verified",
  failed: "failed",
  temporary_failure: "failed",
  pending: "pending",
  not_started: "pending",
};

// Resend's domain status has more granularity ("partially_verified",
// "not_started", ...) than the 4 states this app shows — collapsed here,
// once, rather than leaking that complexity into the UI (see the brief's
// own "do not leak provider-specific status complexity" note).
const DOMAIN_STATUS_MAP: Record<string, DomainStatus> = {
  verified: "verified",
  pending: "pending",
  not_started: "pending",
  partially_verified: "pending",
  failed: "failed",
  partially_failed: "failed",
};

function normalizeRecords(records: unknown): DnsRecordDto[] {
  if (!Array.isArray(records)) return [];
  return records.map((r: any) => ({
    type: r.type,
    name: r.name,
    value: r.value,
    priority: r.priority,
    status: RECORD_STATUS_MAP[r.status] ?? "pending",
  }));
}

// Never surfaces the raw provider message/stack to a user — Resend's own
// error text references field names ("name", "region", ...) a company
// owner has no context for. "restricted_api_key" is the one case worth
// calling out by name rather than folding into the generic fallback: it
// means RESEND_API_KEY itself is scoped to "Sending access" only, which
// Resend's Domains API rejects outright regardless of retrying — an
// INPRN-side configuration problem, not a transient failure or something
// the company owner did wrong.
function friendlyError(error: { name?: string; message?: string } | null | undefined, fallback: string): Error {
  if (error?.name === "restricted_api_key") {
    return new Error(
      "Email domain management isn't available right now — this needs attention from INPRN support, not a retry."
    );
  }
  return new Error(fallback);
}

export interface CreatedDomain {
  resendDomainId: string;
  status: DomainStatus;
  records: DnsRecordDto[];
}

export async function createResendDomain(domain: string): Promise<CreatedDomain> {
  const { data, error } = await getResend().domains.create({ name: domain });
  if (error || !data) {
    if (error?.name === "validation_error") {
      throw friendlyError(error, "That doesn't look like a valid domain — double-check it and try again.");
    }
    throw friendlyError(error, "We couldn't connect that domain right now. Please try again shortly.");
  }

  return {
    resendDomainId: data.id,
    status: DOMAIN_STATUS_MAP[data.status] ?? "pending",
    records: normalizeRecords((data as any).records),
  };
}

export interface FetchedDomain {
  status: DomainStatus;
  records: DnsRecordDto[];
}

export async function fetchResendDomain(resendDomainId: string): Promise<FetchedDomain> {
  const { data, error } = await getResend().domains.get(resendDomainId);
  if (error || !data) {
    throw friendlyError(error, "We couldn't check this domain's status right now. Please try again shortly.");
  }

  return {
    status: DOMAIN_STATUS_MAP[data.status] ?? "pending",
    records: normalizeRecords((data as any).records),
  };
}

// Resend's verify response carries no status/records of its own — it just
// kicks off a re-check. Callers must call fetchResendDomain right after to
// get the refreshed state; kept as two steps so a caller that only wants
// to trigger it isn't forced into an immediate second round trip.
export async function triggerResendDomainVerification(resendDomainId: string): Promise<void> {
  const { error } = await getResend().domains.verify(resendDomainId);
  if (error) {
    throw friendlyError(error, "We couldn't trigger verification right now. Please try again shortly.");
  }
}

export async function removeResendDomain(resendDomainId: string): Promise<void> {
  const { error } = await getResend().domains.remove(resendDomainId);
  if (error) {
    throw friendlyError(error, "We couldn't remove this domain right now. Please try again shortly.");
  }
}
