// Creates a deposit invoice — a single line item for a % of an accepted
// Quote's total — triggered from quoteController.ts's respondToPublicQuote
// on accept. Modeled on createDraftInvoice.ts's create/retry shape, but
// deliberately skips its resolveSelectedWork/job-locking entirely: a
// deposit has no linked Job or JobAssignment to lock, just a flat amount.
import mongoose from "mongoose";
import Invoice from "../../models/invoiceModel.js";
import Company from "../../models/company.js";
import type Client from "../../models/clientModel.js";
import { nextInvoiceNumber } from "./createDraftInvoice.js";
import { round2 } from "./calculations.js";
import { buildClientSnapshot } from "../../utils/buildClientSnapshot.js";

export interface CreateDepositInvoiceParams {
    companyId: mongoose.Types.ObjectId;
    createdBy: mongoose.Types.ObjectId;
    client: InstanceType<typeof Client>;
    quoteNumber: string;
    quoteTotal: number;
    percentage: number;
}

export async function createDepositInvoice(params: CreateDepositInvoiceParams) {
    const { companyId, createdBy, client, quoteNumber, quoteTotal, percentage } = params;
    const amount = round2(quoteTotal * (percentage / 100));

    const company = await Company.findById(companyId).select("currency").lean();
    const issueDate = new Date();

    let invoice;
    for (let attempt = 0; attempt < 5; attempt++) {
        try {
            invoice = await Invoice.create({
                company: companyId,
                createdBy,
                invoiceNumber: await nextInvoiceNumber(companyId, attempt),
                client: client._id,
                clientSnapshot: buildClientSnapshot(client),
                jobs: [],
                assignments: [],
                issueDate,
                // Due immediately, not net-30 — this is securing a booking,
                // not billing for completed work.
                dueDate: issueDate,
                lineItems: [
                    {
                        description: `Deposit (${percentage}%) — Quote ${quoteNumber}`,
                        type: "fixed",
                        job: null,
                        assignment: null,
                        quantity: 1,
                        rate: amount,
                        amount,
                    },
                ],
                subtotal: amount,
                vatRate: 0,
                vatAmount: 0,
                total: amount,
                currency: company?.currency ?? "GBP",
            });
            break;
        } catch (err: any) {
            // Duplicate invoiceNumber (race with a concurrent create) —
            // retry with the next number, same pattern as
            // createDraftInvoice.ts.
            if (err?.code === 11000 && attempt < 4) continue;
            throw err;
        }
    }

    return invoice!;
}
