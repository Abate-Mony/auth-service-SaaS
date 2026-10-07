// Builds a draft Quote from a Lead's public-wizard submission
// (Client.quoteIntake) instead of a staff-filled form — the bridge between
// the public Quote Workflow wizard and the existing, authenticated Quote
// system (quoteModel.ts/quoteController.ts). Reuses that system's own
// building blocks (buildClientSnapshot, nextQuoteNumber, computeTotals)
// rather than re-deriving them, so a wizard-sourced quote behaves exactly
// like a hand-built one from here on — same PDF, same send flow, same
// public accept link.
import mongoose from "mongoose";
import Quote from "../../models/quoteModel.js";
import Company from "../../models/company.js";
import type Client from "../../models/clientModel.js";
import { computeTotals, nextQuoteNumber } from "../../controllers/quoteController.js";
import { buildClientSnapshot } from "../../utils/buildClientSnapshot.js";
import { round2 } from "../invoice/calculations.js";
import type { ComputedEstimate } from "../quoteWorkflow/estimatePrice.js";
import type { QuoteWorkflowServiceType } from "../../models/quoteWorkflowModel.js";

const VALID_FOR_DAYS = 14;

export async function createQuoteFromLeadIntake(params: {
    companyId: mongoose.Types.ObjectId;
    createdBy: mongoose.Types.ObjectId;
    lead: InstanceType<typeof Client>;
    service: QuoteWorkflowServiceType;
    estimate: ComputedEstimate;
}) {
    const { companyId, createdBy, lead, service, estimate } = params;

    const items = estimate.lines.map(line => ({
        description: line.label,
        quantity: 1,
        unitPrice: round2(line.price),
        amount: round2(line.price),
    }));
    const { subtotal, taxAmount, total } = computeTotals(items, 0);

    const companyDoc = await Company.findById(companyId).select("currency").lean();

    const validUntil = new Date();
    validUntil.setDate(validUntil.getDate() + VALID_FOR_DAYS);

    let quote;
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            quote = await Quote.create({
                company: companyId,
                createdBy,
                quoteNumber: await nextQuoteNumber(companyId, attempt),
                client: lead._id,
                clientSnapshot: buildClientSnapshot(lead),
                title: service.label,
                chargeType: "fixed",
                chargeAmount: total,
                items,
                subtotal,
                taxRate: 0,
                taxAmount,
                total,
                currency: companyDoc?.currency ?? "GBP",
                validUntil,
                depositPercentage: service.depositPercentage ?? 0,
                source: "public_wizard",
            });
            break;
        } catch (err: any) {
            // Duplicate quoteNumber (race with a concurrent create) — retry
            // with the next number, same pattern as quoteController's own
            // createQuote.
            if (err?.code === 11000 && attempt < 2) continue;
            throw err;
        }
    }

    return quote!;
}
