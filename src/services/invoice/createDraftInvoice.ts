// services/invoice/createDraftInvoice.ts
//
// The actual "build an invoice from eligible work" logic — extracted from
// invoiceController.ts's createInvoiceDraft so both the manager-triggered
// HTTP endpoint and the automated recurring-invoice generator
// (recurringInvoiceGenerator.ts) go through the exact same locking/
// numbering/snapshot logic. Nothing here is Express-specific; callers
// handle their own req/res and error responses.
import mongoose from "mongoose";
import Job from "../../models/jobModel.js";
import JobAssignment from "../../models/JobAssignment.js";
import Invoice from "../../models/invoiceModel.js";
import Company from "../../models/company.js";
import { BadRequestError } from "../../errors/customErrors.js";
import { resolveSelectedWork } from "./eligibility.js";
import { calculateVat, getInvoiceDueDate, round2 } from "./calculations.js";

export const nextInvoiceNumber = async (companyId: mongoose.Types.ObjectId, attempt = 0): Promise<string> => {
  const count = await Invoice.countDocuments({ company: companyId });
  return `INV-${String(count + 1 + attempt).padStart(4, "0")}`;
};

export interface CreateDraftInvoiceParams {
  companyId: mongoose.Types.ObjectId;
  createdBy: mongoose.Types.ObjectId | string;
  clientId: string;
  periodStart: Date;
  periodEnd: Date;
  jobIds?: string[];
  assignmentIds?: string[];
  // Optional fields here (rather than the Zod schema's real output shape)
  // to match what TS infers through parseOrThrow's generic for a field with
  // a Zod .default() — the actual runtime values are always fully
  // populated by the time a caller has parsed its input, hence the ?? "" /
  // ?? "charge" fallbacks below.
  adjustments?: { description?: string; type?: "charge" | "discount"; amount?: number }[];
  issueDate?: Date;
  dueDate?: Date;
  notes?: string;
  purchaseOrderNumber?: string;
  vatRate?: number;
}

export async function createDraftInvoice(params: CreateDraftInvoiceParams) {
  const {
    companyId,
    createdBy,
    clientId,
    periodStart,
    periodEnd,
    jobIds,
    assignmentIds,
    adjustments = [],
    notes = "",
    purchaseOrderNumber,
  } = params;

  // Re-queries and recalculates from scratch — a caller's selection is only
  // ever "which ids", never trusted for the amounts.
  const [resolved, company] = await Promise.all([
    resolveSelectedWork(companyId.toString(), clientId, periodStart, periodEnd, { jobIds, assignmentIds }),
    Company.findById(companyId).select("currency"),
  ]);

  const workLineItems = resolved.items.map(item => ({
    description: item.title,
    type: item.chargeType,
    job: item.jobId,
    assignment: item.assignmentId ?? null,
    date: item.date,
    startTime: item.startTime,
    endTime: item.endTime,
    location: item.location,
    workerName: item.workerName ?? null,
    minutes: item.approvedMinutes ?? 0,
    quantity: item.quantity,
    rate: item.rate,
    amount: item.amount,
  }));

  const adjustmentLineItems = adjustments.map(adj => {
    const amount = adj.amount ?? 0;
    const signedAmount = round2(adj.type === "discount" ? -Math.abs(amount) : Math.abs(amount));
    return {
      description: adj.description ?? "Adjustment",
      type: "adjustment" as const,
      job: null,
      assignment: null,
      quantity: 1,
      rate: signedAmount,
      amount: signedAmount,
    };
  });

  const lineItems = [...workLineItems, ...adjustmentLineItems];

  const currencySymbol = company?.currency === "USD" ? "$" : company?.currency === "EUR" ? "€" : "£";
  const subtotal = round2(lineItems.reduce((sum, li) => sum + li.amount, 0));
  if (subtotal < 0) {
    throw new BadRequestError(`Adjustments can't bring the invoice below ${currencySymbol}0 — reduce the discount amount.`);
  }
  const vatRate = params.vatRate ?? 0;
  const vatAmount = calculateVat(subtotal, vatRate);
  const total = round2(subtotal + vatAmount);
  if (total < 0) {
    throw new BadRequestError(`Adjustments can't bring the invoice below ${currencySymbol}0 — reduce the discount amount.`);
  }

  const issueDate = params.issueDate ?? new Date();
  const dueDate = params.dueDate ?? getInvoiceDueDate(issueDate, resolved.client.paymentTermsDays ?? 30);

  // ── Locking, without a multi-document transaction ──────────────────
  // Nothing else in this app relies on one, and nothing guarantees the
  // deployment is a replica set — so the lock IS the write: a conditional
  // update that only matches sources not already invoiced. Pre-generating
  // the Invoice's _id lets the lock attach the real invoice reference in
  // the same atomic step as flipping billingStatus, rather than a second
  // write after the fact. If two requests race for the same job or
  // assignment, only one's conditional update actually matches — the
  // loser's modifiedCount comes back short and it backs out cleanly
  // instead of double-booking the work.
  const invoiceId = new mongoose.Types.ObjectId();

  const jobLock = resolved.jobIds.length
    ? await Job.updateMany(
        { _id: { $in: resolved.jobIds }, billingStatus: { $ne: "invoiced" } },
        { $set: { billingStatus: "invoiced", invoice: invoiceId } }
      )
    : { modifiedCount: 0 };
  const assignmentLock = resolved.assignmentIds.length
    ? await JobAssignment.updateMany(
        { _id: { $in: resolved.assignmentIds }, billingStatus: { $ne: "invoiced" } },
        { $set: { billingStatus: "invoiced", invoice: invoiceId } }
      )
    : { modifiedCount: 0 };

  const fullyLocked =
    jobLock.modifiedCount === resolved.jobIds.length && assignmentLock.modifiedCount === resolved.assignmentIds.length;

  const releaseLock = () =>
    Promise.all([
      resolved.jobIds.length
        ? Job.updateMany({ _id: { $in: resolved.jobIds } }, { $set: { billingStatus: "pending", invoice: null } })
        : Promise.resolve(),
      resolved.assignmentIds.length
        ? JobAssignment.updateMany({ _id: { $in: resolved.assignmentIds } }, { $set: { billingStatus: "pending", invoice: null } })
        : Promise.resolve(),
    ]);

  if (!fullyLocked) {
    await releaseLock();
    throw new BadRequestError("Some of the selected work was just invoiced by someone else. Refresh and try again.");
  }

  let invoice;
  try {
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        invoice = await Invoice.create({
          _id: invoiceId,
          company: companyId,
          createdBy,
          invoiceNumber: await nextInvoiceNumber(companyId, attempt),
          client: resolved.client._id,
          clientSnapshot: {
            name: resolved.client.name,
            billingEmail: resolved.client.billingEmail,
            vatNumber: resolved.client.vatNumber,
            phone: resolved.client.phone,
            contactName:
              resolved.client.contacts?.find((c: any) => c.isPrimary)?.name ??
              resolved.client.contacts?.[0]?.name,
            address: resolved.client.address,
          },
          jobs: resolved.jobIds,
          assignments: resolved.assignmentIds,
          servicePeriod: { start: periodStart, end: periodEnd },
          issueDate,
          dueDate,
          purchaseOrderNumber,
          lineItems,
          subtotal,
          vatRate,
          vatAmount,
          total,
          currency: company?.currency ?? "GBP",
          notes,
        });
        break;
      } catch (err: any) {
        // Duplicate invoiceNumber (race with another concurrent create) —
        // retry with the next number; the lock above already protects
        // against the same *work* being reused.
        if (err?.code === 11000 && attempt < 4) continue;
        throw err;
      }
    }
  } catch (err) {
    // The invoice itself never got created — release the lock so this
    // work isn't stranded as "invoiced" against nothing.
    await releaseLock();
    throw err;
  }

  return invoice!;
}
