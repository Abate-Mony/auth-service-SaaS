import { StatusCodes } from "http-status-codes";
import mongoose from "mongoose";
import { z } from "zod";
import { BadRequestError, NotFoundError } from "../errors/customErrors.js";
import { MiddlewareFn } from "../interfaces/expresstype.js";
import Client from "../models/clientModel.js";
import Job from "../models/jobModel.js";
import JobAssignment from "../models/JobAssignment.js";
import Invoice from "../models/invoiceModel.js";
import Company from "../models/company.js";
import { generateInvoicePdf } from "../utils/invoicePdf.js";
import { sendInvoiceEmail } from "../utils/mailTemplates.js";
import { getEligibleWork, resolveSelectedWork } from "../services/invoice/eligibility.js";
import { computeCurrentBillingPeriod } from "../services/invoice/billingPeriod.js";
import { calculateVat, getInvoiceDueDate, round2 } from "../services/invoice/calculations.js";
import dayjs from "../utils/dayjsSetup.js";
import { toUtcDay } from "../utils/dates.js";

// Same escaping precedent as clientController's search — regex
// metacharacters in user input would otherwise be interpreted as regex
// syntax, and a pathological pattern is a cheap ReDoS vector.
const escapeRegExp = (input: string): string => input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const lineItemInputSchema = z.object({
    description: z.string().trim().min(1, "Description is required"),
    hours: z.number().min(0, "Hours can't be negative"),
    rate: z.number().min(0, "Rate can't be negative"),
});

// Matches the frontend's invoiceSchema exactly — `job`/`client` are plain
// strings (a job id, and either a client id or a client name pending the
// frontend's own Client-picker integration; see resolveClient below).
const createInvoiceSchema = z
    .object({
        job: z.string().min(1, "Job is required"),
        client: z.string().min(1, "Client is required"),
        issueDate: z.string().min(1, "Issue date is required"),
        dueDate: z.string().min(1, "Due date is required"),
        lineItems: z.array(lineItemInputSchema).min(1, "Add at least one line item"),
        notes: z.string().optional(),
    })
    .strict();

const updateInvoiceSchema = createInvoiceSchema.partial().strict();

const statusSchema = z
    .object({ status: z.enum(["draft", "sent", "paid", "cancelled"]) })
    .strict();

const parseOrThrow = <T>(schema: z.ZodSchema<T>, body: unknown): T => {
    try {
        return schema.parse(body);
    } catch (err) {
        if (err instanceof z.ZodError) {
            const message = err.issues
                .map(issue => `${issue.path.join(".") || "value"}: ${issue.message}`)
                .join("; ");
            throw new BadRequestError(message);
        }
        throw err;
    }
};

// The frontend doesn't have a real Client-picker on the invoice form yet
// (it just sends the client's name as free text) — accept either a real
// Client id or a name, finding-or-creating by name so invoices still tie
// back to a proper Client record instead of drifting into free text.
const resolveClient = async (input: string, companyId: mongoose.Types.ObjectId, createdBy: string) => {
    const trimmed = input.trim();
    if (!trimmed) throw new BadRequestError("Client is required.");

    if (mongoose.Types.ObjectId.isValid(trimmed)) {
        const byId = await Client.findOne({ _id: trimmed, company: companyId, isDeleted: false });
        if (byId) return byId;
    }

    const safe = escapeRegExp(trimmed);
    let client = await Client.findOne({
        company: companyId,
        name: { $regex: `^${safe}$`, $options: "i" },
        isDeleted: false,
    });

    if (!client) {
        client = await Client.create({ name: trimmed, company: companyId, createdBy });
    }

    return client;
};

const resolveJob = async (jobId: string, companyId: mongoose.Types.ObjectId) => {
    if (!mongoose.Types.ObjectId.isValid(jobId)) {
        throw new BadRequestError("A valid job is required.");
    }

    // Job.company is schema-typed String (a pre-existing quirk elsewhere in
    // this codebase), unlike Client/Invoice's ObjectId.
    const job = await Job.findOne({ _id: jobId, company: companyId.toString(), isDeleted: false });
    if (!job) throw new NotFoundError("Job not found.");
    return job;
};

const buildLineItems = (input: z.infer<typeof lineItemInputSchema>[]) =>
    input.map(li => ({
        description: li.description,
        type: "hourly" as const,
        minutes: Math.round(li.hours * 60),
        quantity: 1,
        rate: li.rate,
        amount: Number((li.hours * li.rate).toFixed(2)),
    }));

const nextInvoiceNumber = async (companyId: mongoose.Types.ObjectId, attempt = 0): Promise<string> => {
    const count = await Invoice.countDocuments({ company: companyId });
    return `INV-${String(count + 1 + attempt).padStart(4, "0")}`;
};

// Overdue is a derived virtual on the model, not a stored value — computed
// here in JS so it works uniformly on both hydrated docs and .lean() results
// (Mongoose virtuals don't run on lean objects).
const computeDisplayStatus = (inv: any): string => {
    if (
        inv.status === "sent" &&
        inv.dueDate &&
        new Date(inv.dueDate) < new Date() &&
        (inv.amountPaid ?? 0) < (inv.total ?? 0)
    ) {
        return "overdue";
    }
    return inv.status;
};

// The frontend's Invoice type treats `client` as the display name and each
// line item as {description, hours, rate} — reshape the richer backend
// document into that same flat shape rather than changing the frontend.
// `type`/`quantity`/`job`/`assignment`/`amount` ride along additively for
// the newer eligible-work-driven UI, which needs to tell fixed line items
// (no meaningful "hours") apart from hourly ones.
const serializeInvoice = (inv: any) => ({
    ...inv,
    client: inv.clientSnapshot?.name ?? "",
    // Frontend's manual-entry edit form only deals with one job (a hidden
    // field carried over from creation) even though the model — and the
    // eligible-work flow — supports several.
    job: inv.jobs?.[0] ? String(inv.jobs[0]) : "",
    jobs: (inv.jobs ?? []).map((j: any) => String(j)),
    assignments: (inv.assignments ?? []).map((a: any) => String(a)),
    status: computeDisplayStatus(inv),
    lineItems: (inv.lineItems ?? []).map((li: any) => ({
        description: li.description,
        hours: Number(((li.minutes ?? 0) / 60).toFixed(2)),
        rate: li.rate,
        type: li.type ?? "hourly",
        quantity: li.quantity ?? 1,
        amount: li.amount,
        job: li.job ? String(li.job) : null,
        assignment: li.assignment ? String(li.assignment) : null,
        // Shift snapshot — absent on adjustment lines and on legacy items
        // created before this existed (the frontend falls back to a
        // generic "other charges" row when date/location aren't present).
        date: li.date ?? null,
        startTime: li.startTime ?? null,
        endTime: li.endTime ?? null,
        location: li.location ?? null,
        workerName: li.workerName ?? null,
    })),
});

// GET /invoices?search=&status=&sort=&page=
export const getAllInvoices: MiddlewareFn = async (req, res) => {
    const {
        search, status, sort = "issueDate_desc", page = "1", limit = "20",
        client, start, end,
    } = req.query as Record<string, string | undefined>;

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit ?? "20", 10) || 20));
    const skip = (pageNum - 1) * limitNum;

    const companyId = new mongoose.Types.ObjectId(req.user.company_id.toString());
    const match: Record<string, any> = { company: companyId, isDeleted: false };

    if (status && status !== "all") {
        if (status === "overdue") {
            match.status = "sent";
            match.dueDate = { $lt: new Date() };
        } else if (["draft", "sent", "paid", "cancelled"].includes(status)) {
            match.status = status;
        }
    }

    if (client) {
        if (!mongoose.Types.ObjectId.isValid(client)) {
            throw new BadRequestError("Invalid client id.");
        }
        match.client = new mongoose.Types.ObjectId(client);
    }

    // issueDate is a real Date field (not normalised like Job.date), but
    // both bounds are still whole calendar days — same toUtcDay-based
    // $gte/$lte pattern as jobController.ts's getAllJobs.
    if (start || end) {
        const dateFilter: Record<string, Date> = {};
        try {
            if (start) dateFilter.$gte = toUtcDay(start);
            if (end) dateFilter.$lte = toUtcDay(end);
        } catch {
            throw new BadRequestError("Invalid start or end date");
        }
        match.issueDate = dateFilter;
    }

    if (search?.trim()) {
        const safe = escapeRegExp(search.trim());
        match.$or = [
            { invoiceNumber: { $regex: safe, $options: "i" } },
            { "clientSnapshot.name": { $regex: safe, $options: "i" } },
        ];
    }

    const SORT_OPTIONS: Record<string, Record<string, 1 | -1>> = {
        issueDate_desc: { issueDate: -1 },
        issueDate_asc: { issueDate: 1 },
        dueDate_asc: { dueDate: 1 },
        dueDate_desc: { dueDate: -1 },
        total_desc: { total: -1 },
        total_asc: { total: 1 },
        // Pre-existing values, kept working for any caller still sending them.
        asc: { issueDate: 1 },
        desc: { issueDate: -1 },
    };

    const [invoices, total] = await Promise.all([
        Invoice.find(match)
            .sort(SORT_OPTIONS[sort ?? "issueDate_desc"] ?? SORT_OPTIONS.issueDate_desc)
            .skip(skip)
            .limit(limitNum)
            .lean(),
        Invoice.countDocuments(match),
    ]);

    res.status(StatusCodes.OK).json({
        success: true,
        invoices: invoices.map(serializeInvoice),
        page: pageNum,
        limit: limitNum,
        total,
        totalPages: Math.ceil(total / limitNum),
    });
};

export const getInvoice: MiddlewareFn = async (req, res) => {
    const companyId = new mongoose.Types.ObjectId(req.user.company_id.toString());
    const id = req.params.id as string;

    if (!mongoose.Types.ObjectId.isValid(id)) {
        throw new NotFoundError("Invoice not found.");
    }

    const invoice = await Invoice.findOne({ _id: id, company: companyId, isDeleted: false }).lean();
    if (!invoice) throw new NotFoundError("Invoice not found.");

    // Live-joined, not snapshotted — company details changing after an
    // invoice goes out is a far rarer, lower-stakes case than a Client's
    // (which clientSnapshot exists specifically to guard against), so this
    // stays a straightforward join rather than another schema/migration
    // decision. Only fields that actually exist on Company are sent; the
    // frontend skips whichever come back empty.
    const company = await Company.findById(companyId).select("name phone country website").lean();

    res.status(StatusCodes.OK).json({
        success: true,
        invoice: serializeInvoice(invoice),
        company: company ? { name: company.name, phone: company.phone, country: company.country, website: company.website } : null,
    });
};

export const createInvoice: MiddlewareFn = async (req, res) => {
    const data = parseOrThrow(createInvoiceSchema, req.body);
    const companyId = new mongoose.Types.ObjectId(req.user.company_id.toString());

    const [client, job] = await Promise.all([
        resolveClient(data.client, companyId, req.user.user_id.toString()),
        resolveJob(data.job, companyId),
    ]);

    const lineItems = buildLineItems(data.lineItems);
    const subtotal = Number(lineItems.reduce((sum, li) => sum + li.amount, 0).toFixed(2));

    let invoice;
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            invoice = await Invoice.create({
                company: companyId,
                createdBy: req.user.user_id,
                invoiceNumber: await nextInvoiceNumber(companyId, attempt),
                client: client._id,
                clientSnapshot: {
                    name: client.name,
                    billingEmail: client.billingEmail,
                    vatNumber: client.vatNumber,
                    phone: client.phone,
                    contactName: client.contacts?.find((c: any) => c.isPrimary)?.name ?? client.contacts?.[0]?.name,
                    address: client.address,
                },
                jobs: [job._id],
                issueDate: new Date(data.issueDate),
                dueDate: new Date(data.dueDate),
                lineItems,
                subtotal,
                vatRate: 0,
                vatAmount: 0,
                total: subtotal,
                notes: data.notes ?? "",
            });
            break;
        } catch (err: any) {
            // Duplicate invoiceNumber (race with another concurrent create) —
            // retry with the next number rather than failing the request.
            if (err?.code === 11000 && attempt < 2) continue;
            throw err;
        }
    }

    // This manual path doesn't check billingStatus first (an intentional
    // scope limit — see the deliverables report), but it does mark the
    // work invoiced going forward, so the eligible-work picker never offers
    // it again and both creation paths stay consistent. Which record gets
    // marked depends on chargeType, same split as everywhere else: a fixed
    // job is one billable unit (the Job itself), an hourly job is billed
    // per completed JobAssignment — marking the Job there would leave the
    // assignments looking uninvoiced, so the eligible-work picker (and any
    // "which invoice covers this" UI) would miss it entirely.
    if (job.chargeType === "fixed") {
        job.billingStatus = "invoiced" as any;
        (job as any).invoice = invoice!._id;
        await job.save();
    } else {
        const assignments = await JobAssignment.find({ job: job._id, isDeleted: false, status: "completed" }).select("_id");
        if (assignments.length) {
            const assignmentIds = assignments.map(a => a._id);
            await JobAssignment.updateMany(
                { _id: { $in: assignmentIds } },
                { $set: { billingStatus: "invoiced", invoice: invoice!._id } }
            );
            invoice!.assignments = assignmentIds as any;
            await invoice!.save();
        }
    }

    res.status(StatusCodes.CREATED).json({ success: true, invoice: serializeInvoice(invoice!.toObject()) });
};

// General edit — restricted to drafts, since a sent/paid invoice being
// silently rewritten would be surprising and breaks the audit trail an
// invoice is supposed to provide.
export const updateInvoice: MiddlewareFn = async (req, res) => {
    const data = parseOrThrow(updateInvoiceSchema, req.body);
    if (Object.keys(data).length === 0) {
        throw new BadRequestError("No valid fields provided.");
    }

    const companyId = new mongoose.Types.ObjectId(req.user.company_id.toString());
    const invoice = await Invoice.findOne({ _id: req.params.id, company: companyId, isDeleted: false });
    if (!invoice) throw new NotFoundError("Invoice not found.");

    if (invoice.status !== "draft") {
        throw new BadRequestError("Only draft invoices can be edited — cancel and recreate instead.");
    }

    if (data.client !== undefined) {
        const client = await resolveClient(data.client, companyId, req.user.user_id.toString());
        invoice.client = client._id;
        invoice.clientSnapshot = {
            name: client.name,
            billingEmail: client.billingEmail,
            vatNumber: client.vatNumber,
            phone: client.phone,
            contactName: client.contacts?.find((c: any) => c.isPrimary)?.name ?? client.contacts?.[0]?.name,
            address: client.address,
        };
    }

    if (data.job !== undefined) {
        const job = await resolveJob(data.job, companyId);
        invoice.jobs = [job._id];
    }

    if (data.issueDate !== undefined) invoice.issueDate = new Date(data.issueDate);
    if (data.dueDate !== undefined) invoice.dueDate = new Date(data.dueDate);
    if (data.notes !== undefined) invoice.notes = data.notes;

    if (data.lineItems !== undefined) {
        const lineItems = buildLineItems(data.lineItems);
        const subtotal = Number(lineItems.reduce((sum, li) => sum + li.amount, 0).toFixed(2));
        invoice.lineItems = lineItems as any;
        invoice.subtotal = subtotal;
        invoice.total = subtotal + (invoice.vatAmount ?? 0);
    }

    await invoice.save();

    res.status(StatusCodes.OK).json({ success: true, invoice: serializeInvoice(invoice.toObject()) });
};

export const updateInvoiceStatusHandler: MiddlewareFn = async (req, res) => {
    const data = parseOrThrow(statusSchema, req.body);
    const companyId = new mongoose.Types.ObjectId(req.user.company_id.toString());

    const invoice = await Invoice.findOne({ _id: req.params.id, company: companyId, isDeleted: false });
    if (!invoice) throw new NotFoundError("Invoice not found.");

    invoice.status = data.status;
    if (data.status === "sent") {
        invoice.sentAt = invoice.sentAt ?? new Date();
        invoice.lastSentAt = new Date();
    } else if (data.status === "paid") {
        invoice.paidAt = new Date();
        invoice.amountPaid = invoice.total;
    } else if (data.status === "cancelled") {
        invoice.cancelledAt = new Date();
        invoice.cancelledBy = req.user.user_id as any;
    }

    await invoice.save();

    res.status(StatusCodes.OK).json({ success: true, invoice: serializeInvoice(invoice.toObject()) });
};

// Actually emails the invoice (with a PDF attached) to the client's billing
// address and flips it to "sent" in one step, replacing the old
// status-only "Mark as Sent" toggle.
export const sendInvoiceHandler: MiddlewareFn = async (req, res) => {
    const companyId = new mongoose.Types.ObjectId(req.user.company_id.toString());
    const invoice = await Invoice.findOne({ _id: req.params.id, company: companyId, isDeleted: false });
    if (!invoice) throw new NotFoundError("Invoice not found.");

    const billingEmail = invoice.clientSnapshot?.billingEmail;
    if (!billingEmail) {
        throw new BadRequestError("This client has no billing email on file — add one before sending.");
    }

    const company = await Company.findById(companyId).select("name phone").lean();
    const companyName = company?.name ?? "work.wrk";

    const addr = invoice.clientSnapshot?.address;
    const clientAddress = addr
        ? [addr.line1, addr.line2, addr.city, addr.county, addr.postcode, addr.country].filter(Boolean).join(", ")
        : undefined;

    const doc = generateInvoicePdf({
        invoiceNumber: invoice.invoiceNumber,
        companyName,
        companyPhone: company?.phone || undefined,
        clientName: invoice.clientSnapshot?.name ?? "",
        clientAddress: clientAddress || undefined,
        clientVatNumber: invoice.clientSnapshot?.vatNumber || undefined,
        issueDate: invoice.issueDate,
        dueDate: invoice.dueDate,
        servicePeriod: invoice.servicePeriod?.start && invoice.servicePeriod?.end ? invoice.servicePeriod : undefined,
        purchaseOrderNumber: invoice.purchaseOrderNumber || undefined,
        lineItems: invoice.lineItems.map(li => ({
            description: li.description,
            type: (li.type ?? "hourly") as "hourly" | "fixed" | "adjustment",
            date: li.date,
            startTime: li.startTime,
            endTime: li.endTime,
            location: li.location,
            workerName: li.workerName,
            hours: Number(((li.minutes ?? 0) / 60).toFixed(2)),
            rate: li.rate,
            amount: li.amount,
        })),
        subtotal: invoice.subtotal,
        vatRate: invoice.vatRate ?? 0,
        vatAmount: invoice.vatAmount ?? 0,
        total: invoice.total,
        currency: invoice.currency,
        notes: invoice.notes,
    });

    const buffers: Buffer[] = [];
    doc.on("data", chunk => buffers.push(chunk));
    const pdfBuffer = await new Promise<Buffer>((resolve, reject) => {
        doc.on("end", () => resolve(Buffer.concat(buffers)));
        doc.on("error", reject);
        doc.end();
    });

    await sendInvoiceEmail({
        to: billingEmail,
        companyName,
        clientContactName: invoice.clientSnapshot?.contactName,
        invoiceNumber: invoice.invoiceNumber,
        total: invoice.total,
        currency: invoice.currency,
        dueDate: invoice.dueDate,
        pdfBuffer,
    });

    invoice.status = "sent";
    invoice.sentAt = invoice.sentAt ?? new Date();
    invoice.lastSentAt = new Date();
    invoice.sentTo = Array.from(new Set([...(invoice.sentTo ?? []), billingEmail]));
    await invoice.save();

    res.status(StatusCodes.OK).json({ success: true, invoice: serializeInvoice(invoice.toObject()) });
};

export const deleteInvoice: MiddlewareFn = async (req, res) => {
    const companyId = req.user.company_id;
    const invoice = await Invoice.findOne({ _id: req.params.id, company: companyId, isDeleted: false });
    if (!invoice) throw new NotFoundError("Invoice not found.");

    invoice.isDeleted = true;
    await invoice.save();

    // A deleted invoice is gone for good — its locked work must come back,
    // or it would be permanently unbillable (stuck pointing at an invoice
    // that no longer exists). Unlike cancel, this applies no matter what
    // status the invoice was in.
    await Promise.all([
        (invoice.jobs ?? []).length
            ? Job.updateMany({ _id: { $in: invoice.jobs } }, { $set: { billingStatus: "pending", invoice: null } })
            : Promise.resolve(),
        (invoice.assignments ?? []).length
            ? JobAssignment.updateMany(
                  { _id: { $in: invoice.assignments } },
                  { $set: { billingStatus: "pending", invoice: null } }
              )
            : Promise.resolve(),
    ]);

    res.status(StatusCodes.OK).json({ success: true, msg: "Invoice deleted." });
};

// ─────────────────────────────────────────────────────────────
// Eligible-work-driven creation
// ─────────────────────────────────────────────────────────────
// The flow above (createInvoice/updateInvoice) is manual: one job, hand-typed
// hours and rate. Kept exactly as-is — per-job manual billing must stay
// possible regardless of a client's billing policy. Everything below adds
// the other path: pick a client + period, see exactly what's ready to bill
// (real approved hours, real charge rates, real fixed amounts), and create
// a draft the backend recalculates from scratch rather than trusting the UI.

const eligibleWorkQuerySchema = z
    .object({
        client: z.string().refine(v => mongoose.Types.ObjectId.isValid(v), "Invalid client id."),
        start: z.string().min(1, "start is required"),
        end: z.string().min(1, "end is required"),
    })
    .strict();

// GET /invoices/eligible-work?client=&start=&end=
export const getEligibleWorkHandler: MiddlewareFn = async (req, res) => {
    const { client, start, end } = parseOrThrow(eligibleWorkQuerySchema, req.query);
    const companyId = req.user.company_id.toString();

    const startDate = dayjs(start).startOf("day").toDate();
    const endDate = dayjs(end).endOf("day").toDate();
    if (dayjs(endDate).isBefore(startDate)) {
        throw new BadRequestError("end cannot be before start.");
    }

    const result = await getEligibleWork(companyId, client, startDate, endDate);
    res.status(StatusCodes.OK).json({ success: true, ...result });
};

const billingInfoQuerySchema = z
    .object({ client: z.string().refine(v => mongoose.Types.ObjectId.isValid(v), "Invalid client id.") })
    .strict();

// GET /invoices/billing-info?client=<id> — powers the "billing schedule"
// panel on the create-invoice page: the client's cadence, the currently
// open period for it (null for per_job/manual clients), and the period the
// last real invoice covered, so a manager can see at a glance whether
// they'd be generating early or catching up.
export const getClientBillingInfoHandler: MiddlewareFn = async (req, res) => {
    const { client: clientId } = parseOrThrow(billingInfoQuerySchema, req.query);
    const companyId = new mongoose.Types.ObjectId(req.user.company_id.toString());

    const client = await Client.findOne({ _id: clientId, company: companyId, isDeleted: false })
        .select("billingFrequency billingDayOfWeek billingDayOfMonth paymentTermsDays")
        .lean();
    if (!client) throw new NotFoundError("Client not found.");

    const currentPeriod = computeCurrentBillingPeriod(
        client.billingFrequency,
        client.billingDayOfWeek,
        client.billingDayOfMonth
    );

    const lastInvoice = await Invoice.findOne({
        company: companyId,
        client: client._id,
        isDeleted: false,
        status: { $ne: "cancelled" },
        "servicePeriod.start": { $exists: true },
    })
        .sort({ issueDate: -1 })
        .select("invoiceNumber issueDate servicePeriod")
        .lean();

    res.status(StatusCodes.OK).json({
        success: true,
        billingFrequency: client.billingFrequency,
        billingDayOfWeek: client.billingDayOfWeek,
        billingDayOfMonth: client.billingDayOfMonth,
        paymentTermsDays: client.paymentTermsDays,
        currentPeriod,
        lastInvoice: lastInvoice
            ? {
                  invoiceNumber: lastInvoice.invoiceNumber,
                  issueDate: lastInvoice.issueDate,
                  servicePeriod: lastInvoice.servicePeriod,
              }
            : null,
    });
};

const adjustmentInputSchema = z.object({
    description: z.string().trim().min(1, "Adjustment description is required").max(200),
    // "discount" just means the amount is subtracted rather than added —
    // the sign lives on the stored amount either way, this only decides
    // which direction to apply the number the manager typed.
    type: z.enum(["charge", "discount"]).default("charge"),
    amount: z.number().positive("Adjustment amount must be greater than 0"),
});

const createDraftSchema = z
    .object({
        client: z.string().refine(v => mongoose.Types.ObjectId.isValid(v), "Invalid client id."),
        servicePeriod: z.object({
            start: z.string().min(1, "Service period start is required"),
            end: z.string().min(1, "Service period end is required"),
        }),
        jobIds: z.array(z.string()).optional(),
        assignmentIds: z.array(z.string()).optional(),
        adjustments: z.array(adjustmentInputSchema).optional(),
        issueDate: z.string().optional(),
        dueDate: z.string().optional(),
        notes: z.string().optional(),
        purchaseOrderNumber: z.string().optional(),
        // Existing manual invoices are created with 0 VAT (see createInvoice
        // above) — defaulting to 0 here too rather than the model's 20%
        // keeps new invoices consistent with what's actually gone out so
        // far, instead of silently starting to charge VAT nobody asked for.
        vatRate: z.number().min(0).optional(),
    })
    .strict();

// POST /invoices/draft — create a draft from selected eligible-work items.
export const createInvoiceDraft: MiddlewareFn = async (req, res) => {
    const data = parseOrThrow(createDraftSchema, req.body);
    const companyId = new mongoose.Types.ObjectId(req.user.company_id.toString());

    const periodStart = dayjs(data.servicePeriod.start).startOf("day").toDate();
    const periodEnd = dayjs(data.servicePeriod.end).endOf("day").toDate();
    if (dayjs(periodEnd).isBefore(periodStart)) {
        throw new BadRequestError("Service period end cannot be before start.");
    }

    // Re-queries and recalculates from scratch — the frontend's selection is
    // only ever "which ids", never trusted for the amounts.
    const resolved = await resolveSelectedWork(companyId.toString(), data.client, periodStart, periodEnd, {
        jobIds: data.jobIds,
        assignmentIds: data.assignmentIds,
    });

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

    const adjustmentLineItems = (data.adjustments ?? []).map(adj => {
        const signedAmount = round2(adj.type === "discount" ? -Math.abs(adj.amount) : Math.abs(adj.amount));
        return {
            description: adj.description,
            type: "adjustment" as const,
            job: null,
            assignment: null,
            quantity: 1,
            rate: signedAmount,
            amount: signedAmount,
        };
    });

    const lineItems = [...workLineItems, ...adjustmentLineItems];

    const subtotal = round2(lineItems.reduce((sum, li) => sum + li.amount, 0));
    if (subtotal < 0) {
        throw new BadRequestError("Adjustments can't bring the invoice below £0 — reduce the discount amount.");
    }
    const vatRate = data.vatRate ?? 0;
    const vatAmount = calculateVat(subtotal, vatRate);
    const total = round2(subtotal + vatAmount);
    if (total < 0) {
        throw new BadRequestError("Adjustments can't bring the invoice below £0 — reduce the discount amount.");
    }

    const issueDate = data.issueDate ? new Date(data.issueDate) : new Date();
    const dueDate = data.dueDate
        ? new Date(data.dueDate)
        : getInvoiceDueDate(issueDate, resolved.client.paymentTermsDays ?? 30);

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
                ? JobAssignment.updateMany(
                      { _id: { $in: resolved.assignmentIds } },
                      { $set: { billingStatus: "pending", invoice: null } }
                  )
                : Promise.resolve(),
        ]);

    if (!fullyLocked) {
        await releaseLock();
        throw new BadRequestError(
            "Some of the selected work was just invoiced by someone else. Refresh and try again."
        );
    }

    let invoice;
    try {
        for (let attempt = 0; attempt < 5; attempt++) {
            try {
                invoice = await Invoice.create({
                    _id: invoiceId,
                    company: companyId,
                    createdBy: req.user.user_id,
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
                    purchaseOrderNumber: data.purchaseOrderNumber,
                    lineItems,
                    subtotal,
                    vatRate,
                    vatAmount,
                    total,
                    notes: data.notes ?? "",
                });
                break;
            } catch (err: any) {
                // Duplicate invoiceNumber (race with another concurrent
                // create) — retry with the next number; the lock above
                // already protects against the same *work* being reused.
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

    res.status(StatusCodes.CREATED).json({ success: true, invoice: serializeInvoice(invoice!.toObject()) });
};

const markPaidSchema = z
    .object({
        amountPaid: z.number().min(0).optional(),
        paymentReference: z.string().trim().optional(),
        paymentMethod: z.enum(["bank_transfer", "card", "cash", "direct_debit", "other"]).optional(),
        paymentNotes: z.string().trim().max(2000).optional(),
        paidAt: z.string().optional(),
    })
    .strict();

// PATCH /invoices/:id/mark-paid
export const markInvoicePaid: MiddlewareFn = async (req, res) => {
    const data = parseOrThrow(markPaidSchema, req.body);
    const companyId = new mongoose.Types.ObjectId(req.user.company_id.toString());

    const invoice = await Invoice.findOne({ _id: req.params.id, company: companyId, isDeleted: false });
    if (!invoice) throw new NotFoundError("Invoice not found.");
    if (invoice.status === "draft") throw new BadRequestError("Send this invoice before marking it paid.");
    if (invoice.status === "cancelled") throw new BadRequestError("This invoice is cancelled.");

    // MVP: full payment only, per the brief — amountPaid defaults to the
    // full total unless a specific (partial) amount is given.
    invoice.amountPaid = data.amountPaid ?? invoice.total;
    if (data.paymentReference !== undefined) invoice.paymentReference = data.paymentReference;
    if (data.paymentMethod !== undefined) invoice.paymentMethod = data.paymentMethod;
    if (data.paymentNotes !== undefined) invoice.paymentNotes = data.paymentNotes;

    if (invoice.amountPaid >= invoice.total) {
        invoice.status = "paid";
        invoice.paidAt = data.paidAt ? new Date(data.paidAt) : new Date();
    }

    await invoice.save();

    res.status(StatusCodes.OK).json({ success: true, invoice: serializeInvoice(invoice.toObject()) });
};

const cancelInvoiceSchema = z.object({ cancellationReason: z.string().trim().max(1000).optional() }).strict();

// PATCH /invoices/:id/cancel
export const cancelInvoiceHandler: MiddlewareFn = async (req, res) => {
    const data = parseOrThrow(cancelInvoiceSchema, req.body);
    const companyId = new mongoose.Types.ObjectId(req.user.company_id.toString());

    const invoice = await Invoice.findOne({ _id: req.params.id, company: companyId, isDeleted: false });
    if (!invoice) throw new NotFoundError("Invoice not found.");
    if (invoice.status === "cancelled") throw new BadRequestError("This invoice is already cancelled.");
    if (invoice.status === "paid") throw new BadRequestError("A paid invoice can't be cancelled.");

    const wasDraft = invoice.status === "draft";

    invoice.status = "cancelled";
    invoice.cancelledAt = new Date();
    invoice.cancelledBy = req.user.user_id as any;
    if (data.cancellationReason !== undefined) invoice.cancellationReason = data.cancellationReason;

    await invoice.save();

    // A draft was never sent — nothing to preserve a lock for, so its
    // source work goes straight back to invoiceable. A SENT invoice's
    // sources are deliberately left locked: un-billing work the client has
    // already been told about needs a credit-note workflow this MVP
    // doesn't have, not a silent release back into the eligible-work list.
    if (wasDraft) {
        await Promise.all([
            (invoice.jobs ?? []).length
                ? Job.updateMany({ _id: { $in: invoice.jobs } }, { $set: { billingStatus: "pending", invoice: null } })
                : Promise.resolve(),
            (invoice.assignments ?? []).length
                ? JobAssignment.updateMany(
                      { _id: { $in: invoice.assignments } },
                      { $set: { billingStatus: "pending", invoice: null } }
                  )
                : Promise.resolve(),
        ]);
    }

    res.status(StatusCodes.OK).json({ success: true, invoice: serializeInvoice(invoice.toObject()) });
};
