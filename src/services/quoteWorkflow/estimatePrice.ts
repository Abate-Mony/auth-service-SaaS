// Server-side source of truth for a quote's price. Mirrors
// quote.xeniapure.com's configs/dynamic.tsx estimatePrice exactly (same
// additive rules: basePrice + each selected option's priceDelta + each
// number step's value*pricePerUnit) so the number a visitor sees live
// matches what gets trusted here — but this is the copy that actually
// counts. Never trust a client-submitted total (see
// publicQuoteIntakeController.ts's submitPublicQuoteIntake): always
// recompute it from the company's own published workflow plus the
// visitor's answers.
import type { QuoteWorkflowServiceType } from "../../models/quoteWorkflowModel.js";

export interface EstimateLine {
    label: string;
    price: number;
}

export interface ComputedEstimate {
    lines: EstimateLine[];
    total: number;
    requiresManualQuote: boolean;
}

export function computeServiceEstimate(service: QuoteWorkflowServiceType, answers: Record<string, unknown>): ComputedEstimate {
    if (service.requiresManualQuote) {
        return { lines: [], total: 0, requiresManualQuote: true };
    }

    const lines: EstimateLine[] = [{ label: service.label, price: service.basePrice }];

    for (const step of service.steps.filter(s => s.active).sort((a, b) => a.order - b.order)) {
        const value = answers[step.id];
        if (value == null) continue;

        if (step.type === "choice") {
            const opt = step.options?.find(o => o.value === value);
            if (opt?.priceDelta) lines.push({ label: opt.label, price: opt.priceDelta });
        } else if (step.type === "multiselect" && Array.isArray(value)) {
            for (const v of value) {
                const opt = step.options?.find(o => o.value === v);
                if (opt?.priceDelta) lines.push({ label: opt.label, price: opt.priceDelta });
            }
        } else if (step.type === "number" && step.numberConfig?.pricePerUnit) {
            const amount = Number(value) * step.numberConfig.pricePerUnit;
            if (amount) lines.push({ label: step.label, price: amount });
        }
    }

    return { lines, total: lines.reduce((sum, l) => sum + l.price, 0), requiresManualQuote: false };
}
