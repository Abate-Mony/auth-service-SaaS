type QuoteValidity = {
    status: string;
    validUntil?: Date | string | null;
    responseTokenExpiresAt?: Date | string | null;
};

export type QuoteExpiryContext = { publicToken?: boolean };

const isPast = (value: Date | string | null | undefined, now: Date): boolean =>
    value != null && (value instanceof Date ? value.getTime() : new Date(value).getTime()) < now.getTime();

// A deadline changes only an unanswered quote. Terminal outcomes remain
// historical facts. A public link's deadline applies to that link alone.
export function getEffectiveQuoteStatus(
    quote: QuoteValidity,
    now = new Date(),
    context: QuoteExpiryContext = {}
): string {
    if ((quote.status === "sent" || quote.status === "viewed") &&
        (isPast(quote.validUntil, now) ||
            (context.publicToken && isPast(quote.responseTokenExpiresAt, now)))) {
        return "expired";
    }
    return quote.status;
}

// Match the effective status BEFORE pagination/counting. $nor also keeps
// legacy missing deadlines consistent with getEffectiveQuoteStatus.
export function quoteStatusFilter(status: string, now: Date): Record<string, unknown> {
    if (status === "sent" || status === "viewed") {
        return { status, $nor: [{ validUntil: { $lt: now } }] };
    }
    if (status === "expired") {
        return {
            $or: [
                { status: "expired" },
                { status: { $in: ["sent", "viewed"] }, validUntil: { $lt: now } },
            ],
        };
    }
    return { status };
}
