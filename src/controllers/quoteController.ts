import { StatusCodes } from "http-status-codes";
import mongoose from "mongoose";
import { z } from "zod";
import { BadRequestError, NotFoundError } from "../errors/customErrors.js";
import { MiddlewareFn } from "../interfaces/expresstype.js";
import Client from "../models/clientModel.js";
import Site from "../models/siteModel.js";
import Company from "../models/company.js";
import User from "../models/userModel.js";
import Quote from "../models/quoteModel.js";
import { generateQuotePdf } from "../utils/quotePdf.js";
import { resolveQuoteTemplate } from "../utils/resolveInvoiceTemplate.js";
import { fetchImageBuffer } from "../utils/fetchImageBuffer.js";
import { sendQuoteEmail, sendQuoteResponseNotice, sendQuoteThankYouEmail } from "../utils/mailTemplates.js";
import { calculateVat, round2 } from "../services/invoice/calculations.js";
import { createQuoteResponseToken, hashQuoteResponseToken } from "../utils/tokenUtils.js";

// Same escaping precedent as invoiceController/clientController's search.
const escapeRegExp = (input: string): string => input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

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

// Same find-or-create-by-name resolution as invoiceController's resolveClient
// — a quote is very often the first document ever sent to a prospect, who
// may not exist as a Client record yet. Accepts either a real Client id or a
// free-text name.
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

// Sites belong to exactly one Client — never trusted without that scoping,
// same reasoning as jobController's resolveJobSite.
const resolveSite = async (
    siteId: string | undefined,
    companyId: mongoose.Types.ObjectId,
    clientDoc: InstanceType<typeof Client>
) => {
    if (!siteId) return null;
    if (!mongoose.Types.ObjectId.isValid(siteId)) throw new BadRequestError("Invalid site id.");

    const site = await Site.findOne({ _id: siteId, company: companyId, client: clientDoc._id, isDeleted: false });
    if (!site) throw new BadRequestError("Site not found.");

    return site;
};

const buildClientSnapshot = (client: InstanceType<typeof Client>) => ({
    name: client.name,
    billingEmail: client.billingEmail,
    vatNumber: client.vatNumber,
    phone: client.phone,
    contactName: client.contacts?.find((c: any) => c.isPrimary)?.name ?? client.contacts?.[0]?.name,
    address: client.address,
});

// Unlike Job's buildSiteSnapshot, Quote has no top-level address fields of
// its own, so the site's address rides along here too.
const buildSiteSnapshot = (site: InstanceType<typeof Site>) => ({
    name: site.name,
    contact: {
        name: site.contact?.name ?? "",
        phone: site.contact?.phone ?? "",
        email: site.contact?.email ?? "",
    },
    address: site.address,
    accessInstructions: site.accessInstructions ?? "",
    parkingInstructions: site.parkingInstructions ?? "",
});

const quoteItemInputSchema = z
    .object({
        description: z.string().trim().min(1, "Description is required"),
        quantity: z.number().min(0).default(1),
        unitPrice: z.number().min(0, "Unit price can't be negative"),
    })
    .strict();

const createQuoteSchema = z
    .object({
        client: z.string().min(1, "Client is required"),
        site: z.string().optional(),
        title: z.string().trim().min(1, "Title is required"),
        description: z.string().optional(),
        chargeType: z.enum(["hourly", "fixed"]),
        chargeRate: z.number().min(0).optional(),
        chargeAmount: z.number().min(0).optional(),
        items: z.array(quoteItemInputSchema).min(1, "Add at least one item"),
        taxRate: z.number().min(0).max(100).optional(),
        validUntil: z.string().min(1, "Valid-until date is required"),
        notes: z.string().optional(),
        terms: z.string().optional(),
        sendThankYouEmailOnAccept: z.boolean().optional(),
    })
    .strict();

const updateQuoteSchema = createQuoteSchema.partial().strict();

// amount/subtotal/taxAmount/total are always server-computed — never
// trusted raw off a request body (same principle as Invoice).
const buildQuoteItems = (input: z.infer<typeof quoteItemInputSchema>[]) =>
    input.map(it => {
        const quantity = it.quantity ?? 1;
        return {
            description: it.description,
            quantity,
            unitPrice: it.unitPrice,
            amount: round2(quantity * it.unitPrice),
        };
    });

const computeTotals = (items: { amount: number }[], taxRate: number) => {
    const subtotal = round2(items.reduce((sum, it) => sum + it.amount, 0));
    const taxAmount = calculateVat(subtotal, taxRate);
    const total = round2(subtotal + taxAmount);
    return { subtotal, taxAmount, total };
};

const nextQuoteNumber = async (companyId: mongoose.Types.ObjectId, attempt = 0): Promise<string> => {
    const count = await Quote.countDocuments({ company: companyId });
    return `QT-${String(count + 1 + attempt).padStart(4, "0")}`;
};

// "expired" is a real stored status (flipped lazily by the public routes
// below), but a quote that's merely sitting past validUntil and hasn't been
// touched by a client yet should still read as expired in the admin list
// without waiting for someone to click the link.
const computeDisplayStatus = (q: any): string => {
    if ((q.status === "sent" || q.status === "viewed") && q.validUntil && new Date(q.validUntil) < new Date()) {
        return "expired";
    }
    return q.status;
};

const serializeQuote = (q: any) => ({
    ...q,
    // `client` is overridden to the display name (matches Invoice's own
    // serializeInvoice convention) — clientId carries the real ObjectId
    // alongside it, additive, for the one place that actually needs it:
    // CreateJob.tsx's quote-prefill flow (see the accepted-quote → job
    // brief). `site` was never overridden — it's already a raw id.
    client: q.clientSnapshot?.name ?? "",
    clientId: q.client ? String(q.client) : null,
    site: q.site ? String(q.site) : null,
    status: computeDisplayStatus(q),
});

// GET /quotes?search=&status=&sort=&page=
export const getAllQuotes: MiddlewareFn = async (req, res) => {
    const {
        search, status, sort = "createdAt_desc", page = "1", limit = "20", client,
    } = req.query as Record<string, string | undefined>;

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit ?? "20", 10) || 20));
    const skip = (pageNum - 1) * limitNum;

    const companyId = new mongoose.Types.ObjectId(req.user.company_id.toString());
    const match: Record<string, any> = { company: companyId, isDeleted: false };

    if (status && status !== "all") {
        if (["draft", "sent", "viewed", "accepted", "declined", "expired", "cancelled"].includes(status)) {
            match.status = status;
        }
    }

    if (client) {
        if (!mongoose.Types.ObjectId.isValid(client)) throw new BadRequestError("Invalid client id.");
        match.client = new mongoose.Types.ObjectId(client);
    }

    if (search?.trim()) {
        const safe = escapeRegExp(search.trim());
        match.$or = [
            { quoteNumber: { $regex: safe, $options: "i" } },
            { title: { $regex: safe, $options: "i" } },
            { "clientSnapshot.name": { $regex: safe, $options: "i" } },
        ];
    }

    const SORT_OPTIONS: Record<string, Record<string, 1 | -1>> = {
        createdAt_desc: { createdAt: -1 },
        createdAt_asc: { createdAt: 1 },
        validUntil_asc: { validUntil: 1 },
        validUntil_desc: { validUntil: -1 },
        total_desc: { total: -1 },
        total_asc: { total: 1 },
    };

    const [quotes, total] = await Promise.all([
        Quote.find(match)
            .sort(SORT_OPTIONS[sort ?? "createdAt_desc"] ?? SORT_OPTIONS.createdAt_desc)
            .skip(skip)
            .limit(limitNum)
            .lean(),
        Quote.countDocuments(match),
    ]);

    res.status(StatusCodes.OK).json({
        success: true,
        quotes: quotes.map(serializeQuote),
        page: pageNum,
        limit: limitNum,
        total,
        totalPages: Math.ceil(total / limitNum),
    });
};

export const getQuote: MiddlewareFn = async (req, res) => {
    const companyId = new mongoose.Types.ObjectId(req.user.company_id.toString());
    const id = req.params.id as string;
    if (!mongoose.Types.ObjectId.isValid(id)) throw new NotFoundError("Quote not found.");

    const quote = await Quote.findOne({ _id: id, company: companyId, isDeleted: false }).lean();
    if (!quote) throw new NotFoundError("Quote not found.");

    res.status(StatusCodes.OK).json({ success: true, quote: serializeQuote(quote) });
};

export const createQuote: MiddlewareFn = async (req, res) => {
    const data = parseOrThrow(createQuoteSchema, req.body);
    const companyId = new mongoose.Types.ObjectId(req.user.company_id.toString());

    // Checked explicitly here (with a clean 400) rather than relying solely
    // on the model's pre("validate") hook, which throws a bare Error that
    // falls through to a 500 — see quoteModel.ts's comment on that hook.
    if (data.chargeType === "fixed" && (!data.chargeAmount || data.chargeAmount <= 0)) {
        throw new BadRequestError("Enter a charge amount for a fixed-price quote.");
    }
    if (data.chargeType === "hourly" && (!data.chargeRate || data.chargeRate <= 0)) {
        throw new BadRequestError("Enter an hourly rate for an hourly quote.");
    }

    const [client, company] = await Promise.all([
        resolveClient(data.client, companyId, req.user.user_id.toString()),
        Company.findById(companyId).select("currency"),
    ]);
    const site = await resolveSite(data.site, companyId, client);

    const items = buildQuoteItems(data.items);
    const taxRate = data.taxRate ?? 0;
    const { subtotal, taxAmount, total } = computeTotals(items, taxRate);

    let quote;
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            quote = await Quote.create({
                company: companyId,
                createdBy: req.user.user_id,
                quoteNumber: await nextQuoteNumber(companyId, attempt),
                client: client._id,
                clientSnapshot: buildClientSnapshot(client),
                site: site?._id ?? null,
                siteSnapshot: site ? buildSiteSnapshot(site) : undefined,
                title: data.title,
                description: data.description ?? "",
                chargeType: data.chargeType,
                chargeRate: data.chargeRate ?? 0,
                chargeAmount: data.chargeAmount ?? 0,
                items,
                subtotal,
                taxRate,
                taxAmount,
                total,
                currency: company?.currency ?? "GBP",
                validUntil: new Date(data.validUntil),
                notes: data.notes ?? "",
                terms: data.terms ?? "",
                sendThankYouEmailOnAccept: data.sendThankYouEmailOnAccept ?? true,
            });
            break;
        } catch (err: any) {
            // Duplicate quoteNumber (race with another concurrent create) —
            // retry with the next number rather than failing the request.
            if (err?.code === 11000 && attempt < 2) continue;
            throw err;
        }
    }

    res.status(StatusCodes.CREATED).json({ success: true, quote: serializeQuote(quote!.toObject()) });
};

// Restricted to drafts, same rationale as Invoice's updateInvoice — a sent
// quote being silently rewritten would invalidate what the client already
// saw (or already responded to).
export const updateQuote: MiddlewareFn = async (req, res) => {
    const data = parseOrThrow(updateQuoteSchema, req.body);
    if (Object.keys(data).length === 0) {
        throw new BadRequestError("No valid fields provided.");
    }

    const companyId = new mongoose.Types.ObjectId(req.user.company_id.toString());
    const quote = await Quote.findOne({ _id: req.params.id, company: companyId, isDeleted: false });
    if (!quote) throw new NotFoundError("Quote not found.");

    if (quote.status !== "draft") {
        throw new BadRequestError("Only draft quotes can be edited — cancel and recreate instead.");
    }

    if (data.client !== undefined) {
        const client = await resolveClient(data.client, companyId, req.user.user_id.toString());
        quote.client = client._id;
        quote.clientSnapshot = buildClientSnapshot(client) as any;

        // The previously-selected site belongs to the OLD client — carrying
        // it forward would leave siteSnapshot pointing at a site that has
        // nothing to do with the new clientSnapshot. Cleared unless a new
        // site is explicitly provided in the same request.
        if (data.site === undefined) {
            quote.site = null as any;
            (quote as any).siteSnapshot = undefined;
        }
    }

    if (data.site !== undefined) {
        const clientDoc = await Client.findOne({ _id: quote.client, company: companyId, isDeleted: false });
        if (!clientDoc) throw new BadRequestError("Quote's client could not be found.");
        const site = await resolveSite(data.site, companyId, clientDoc);
        quote.site = (site?._id ?? null) as any;
        (quote as any).siteSnapshot = site ? buildSiteSnapshot(site) : undefined;
    }

    if (data.title !== undefined) quote.title = data.title;
    if (data.description !== undefined) quote.description = data.description;
    if (data.notes !== undefined) quote.notes = data.notes;
    if (data.terms !== undefined) quote.terms = data.terms;
    if (data.sendThankYouEmailOnAccept !== undefined) quote.sendThankYouEmailOnAccept = data.sendThankYouEmailOnAccept;
    if (data.validUntil !== undefined) quote.validUntil = new Date(data.validUntil);
    if (data.chargeType !== undefined) quote.chargeType = data.chargeType;
    if (data.chargeRate !== undefined) quote.chargeRate = data.chargeRate;
    if (data.chargeAmount !== undefined) quote.chargeAmount = data.chargeAmount;

    if (quote.chargeType === "fixed" && (!quote.chargeAmount || quote.chargeAmount <= 0)) {
        throw new BadRequestError("Enter a charge amount for a fixed-price quote.");
    }
    if (quote.chargeType === "hourly" && (!quote.chargeRate || quote.chargeRate <= 0)) {
        throw new BadRequestError("Enter an hourly rate for an hourly quote.");
    }

    if (data.items !== undefined) {
        quote.items = buildQuoteItems(data.items) as any;
    }
    if (data.items !== undefined || data.taxRate !== undefined) {
        const taxRate = data.taxRate ?? quote.taxRate ?? 0;
        const { subtotal, taxAmount, total } = computeTotals(quote.items as any, taxRate);
        quote.taxRate = taxRate;
        quote.subtotal = subtotal;
        quote.taxAmount = taxAmount;
        quote.total = total;
    }

    // .save() (not findByIdAndUpdate) so the pre("validate") consistency
    // hook actually runs on this edit — see quoteModel.ts's warning comment.
    await quote.save();

    res.status(StatusCodes.OK).json({ success: true, quote: serializeQuote(quote.toObject()) });
};

export const deleteQuote: MiddlewareFn = async (req, res) => {
    const companyId = req.user.company_id;
    const quote = await Quote.findOne({ _id: req.params.id, company: companyId, isDeleted: false });
    if (!quote) throw new NotFoundError("Quote not found.");

    // Only a draft can be deleted outright — a sent quote must be cancelled
    // instead, same split as Invoice's deleteInvoice/cancelInvoiceHandler.
    if (quote.status !== "draft") {
        throw new BadRequestError("Only draft quotes can be deleted — cancel a sent quote instead.");
    }

    quote.isDeleted = true;
    await quote.save();

    res.status(StatusCodes.OK).json({ success: true, msg: "Quote deleted." });
};

// Shared by sendQuoteHandler and downloadQuotePdf so a manager's "preview"
// download is built from the exact same code path as the one actually
// emailed — see buildInvoicePdfDocument's identical comment in
// invoiceController.ts for the persistTemplate reasoning.
async function buildQuotePdfDocument(
    quote: InstanceType<typeof Quote>,
    companyId: mongoose.Types.ObjectId,
    opts: { persistTemplate: boolean; explicitTemplateId?: string }
) {
    const company = await Company.findById(companyId).select("name phone logo").lean();
    const companyName = company?.name ?? "INPRN";
    const logoBuffer = await fetchImageBuffer(company?.logo?.url);

    const addr = quote.clientSnapshot?.address;
    const clientAddress = addr
        ? [addr.line1, addr.line2, addr.city, addr.county, addr.postcode, addr.country].filter(Boolean).join(", ")
        : undefined;

    // An explicit choice (the send-time template picker) always re-resolves
    // and can override an already-locked snapshot — e.g. picking a
    // different look on resend. With no explicit choice, an already-locked
    // snapshot is reused as-is (the normal "sending never silently changes
    // an already-sent look" rule).
    let snapshot = quote.templateSnapshot;
    if (opts.explicitTemplateId || !snapshot?.baseLayout) {
        const resolved = await resolveQuoteTemplate(companyId, opts.explicitTemplateId ?? quote.template?.toString());
        snapshot = resolved.snapshot;
        if (opts.persistTemplate) {
            quote.template = resolved.templateId as any;
            quote.templateSnapshot = resolved.snapshot as any;
            await quote.save();
        }
    }

    return generateQuotePdf({
        quoteNumber: quote.quoteNumber,
        companyName,
        companyPhone: company?.phone || undefined,
        clientName: quote.clientSnapshot?.name ?? "",
        clientAddress: clientAddress || undefined,
        clientVatNumber: quote.clientSnapshot?.vatNumber || undefined,
        title: quote.title,
        description: quote.description || undefined,
        issueDate: (quote as any).createdAt ?? new Date(),
        validUntil: quote.validUntil,
        items: quote.items.map(it => ({
            description: it.description,
            quantity: it.quantity,
            unitPrice: it.unitPrice,
            amount: it.amount,
        })),
        subtotal: quote.subtotal,
        taxRate: quote.taxRate ?? 0,
        taxAmount: quote.taxAmount ?? 0,
        total: quote.total,
        currency: quote.currency,
        notes: quote.notes,
        terms: quote.terms,
        logoBuffer,
        template: snapshot?.baseLayout
            ? {
                baseLayout: snapshot.baseLayout as "modern" | "classic" | "minimal",
                accentColor: snapshot.accentColor ?? "#1E3A5F",
                font: (snapshot.font ?? "Helvetica") as "Helvetica" | "Times-Roman" | "Inter",
                logoPosition: (snapshot.logoPosition ?? "top-left") as "top-left" | "top-center" | "top-right",
                showVatBreakdown: snapshot.showVatBreakdown ?? true,
                showPaymentTerms: snapshot.showPaymentTerms ?? true,
                showNotes: snapshot.showNotes ?? true,
            }
            : undefined,
    });
}

// GET /quotes/:id/pdf?template=<id> — preview/download without sending.
// Doesn't lock in a template on an unsent quote, same reasoning as
// downloadInvoicePdf. The optional ?template lets the send-time picker
// preview each candidate template before committing to Send.
export const downloadQuotePdf: MiddlewareFn = async (req, res) => {
    const companyId = new mongoose.Types.ObjectId(req.user.company_id.toString());
    const quote = await Quote.findOne({ _id: req.params.id, company: companyId, isDeleted: false });
    if (!quote) throw new NotFoundError("Quote not found.");

    const explicitTemplateId = typeof req.query.template === "string" ? req.query.template : undefined;
    const doc = await buildQuotePdfDocument(quote, companyId, { persistTemplate: false, explicitTemplateId });

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${quote.quoteNumber}.pdf"`);
    doc.pipe(res);
    doc.end();
};

// Emails the quote (PDF attached) to the client's billing address, generates
// the public response token, and flips draft -> sent in one step.
const sendQuoteSchema = z.object({ template: z.string().optional() }).strict();

// Covers both the first send (draft -> sent) and a resend (sent/viewed ->
// sent) in one handler — a resend always rotates the response token, so a
// stale/lost email link can never be replayed after a fresh one goes out.
// Terminal statuses are rejected with a reason specific enough to act on.
export const sendQuoteHandler: MiddlewareFn = async (req, res) => {
    const data = parseOrThrow(sendQuoteSchema, req.body);
    const companyId = new mongoose.Types.ObjectId(req.user.company_id.toString());
    const quote = await Quote.findOne({ _id: req.params.id, company: companyId, isDeleted: false });
    if (!quote) throw new NotFoundError("Quote not found.");

    if (quote.status === "accepted") throw new BadRequestError("This quote has already been accepted — it can't be resent.");
    if (quote.status === "declined") throw new BadRequestError("This quote was declined. Create a new quote instead of resending it.");
    if (quote.status === "expired") throw new BadRequestError("This quote has expired. Create a new quote instead of resending it.");
    if (quote.status === "cancelled") throw new BadRequestError("This quote was cancelled and can't be sent.");
    if (quote.status !== "draft" && quote.status !== "sent" && quote.status !== "viewed") {
        throw new BadRequestError("This quote can't be sent in its current state.");
    }

    const billingEmail = quote.clientSnapshot?.billingEmail;
    if (!billingEmail) {
        throw new BadRequestError("This client has no billing email on file — add one before sending.");
    }

    const company = await Company.findById(companyId).select("name phone emailSettings").lean();

    const doc = await buildQuotePdfDocument(quote, companyId, { persistTemplate: true, explicitTemplateId: data.template });

    const buffers: Buffer[] = [];
    doc.on("data", chunk => buffers.push(chunk));
    const pdfBuffer = await new Promise<Buffer>((resolve, reject) => {
        doc.on("end", () => resolve(Buffer.concat(buffers)));
        doc.on("error", reject);
        doc.end();
    });

    // Rotated every send, including a resend — an old email (lost, bounced,
    // or just superseded) must never keep working once a fresh one goes out.
    const { token, hash, expiresAt } = createQuoteResponseToken();

    await sendQuoteEmail({
        email: billingEmail,
        clientContactName: quote.clientSnapshot?.contactName,
        company: company ?? { name: "INPRN" },
        quoteNumber: quote.quoteNumber,
        title: quote.title,
        total: quote.total,
        currency: quote.currency,
        validUntil: quote.validUntil,
        responseToken: token,
        pdfBuffer,
    });

    quote.responseTokenHash = hash;
    quote.responseTokenExpiresAt = expiresAt;
    quote.status = "sent";
    quote.sentAt = quote.sentAt ?? new Date();
    quote.lastSentAt = new Date();
    await quote.save();

    res.status(StatusCodes.OK).json({ success: true, quote: serializeQuote(quote.toObject()) });
};

const cancelQuoteSchema = z.object({ cancellationReason: z.string().trim().max(1000).optional() }).strict();

// PATCH /quotes/:id/cancel — the agency withdrawing its own quote. Distinct
// from the client declining it (respondToPublicQuote below).
export const cancelQuoteHandler: MiddlewareFn = async (req, res) => {
    const data = parseOrThrow(cancelQuoteSchema, req.body);
    const companyId = new mongoose.Types.ObjectId(req.user.company_id.toString());

    const quote = await Quote.findOne({ _id: req.params.id, company: companyId, isDeleted: false });
    if (!quote) throw new NotFoundError("Quote not found.");
    if (quote.status === "cancelled") throw new BadRequestError("This quote is already cancelled.");
    if (quote.status === "accepted") throw new BadRequestError("An accepted quote can't be cancelled.");

    quote.status = "cancelled";
    quote.cancelledAt = new Date();
    quote.cancelledBy = req.user.user_id as any;
    if (data.cancellationReason !== undefined) quote.cancellationReason = data.cancellationReason;

    await quote.save();

    res.status(StatusCodes.OK).json({ success: true, quote: serializeQuote(quote.toObject()) });
};

// ─────────────────────────────────────────────────────────────
// Public (no auth, token-based) — same recipe as
// invitationController's loadAcceptableInvitation.
// ─────────────────────────────────────────────────────────────

// Looks a quote up by its public token and applies the lazy expiry flip —
// used by BOTH the view (GET) and respond (POST) endpoints. Deliberately
// does NOT reject on status: a client opening the link for an already
// accepted/declined/cancelled quote must still see that outcome rendered
// (see getPublicQuote below), not a bare "invalid link" error. Only
// respondToPublicQuote's assertRespondable actually gates on status.
async function findQuoteByToken(token: unknown) {
    if (!token || typeof token !== "string") {
        throw new BadRequestError("Quote token is required.", "QUOTE_INVALID");
    }

    const hash = hashQuoteResponseToken(token);
    // responseTokenHash has select:false — that only affects the fields a
    // query RETURNS, not what it can filter on, same as Invitation.tokenHash.
    const quote = await Quote.findOne({ responseTokenHash: hash });
    if (!quote) throw new NotFoundError("This quote link is invalid.", "QUOTE_NOT_FOUND");

    const isExpired =
        (quote.status === "sent" || quote.status === "viewed") &&
        ((quote.responseTokenExpiresAt ? quote.responseTokenExpiresAt < new Date() : false) ||
            quote.validUntil < new Date());

    if (isExpired) {
        quote.status = "expired";
        await quote.save();
    }

    return quote;
}

// Gate for the write path only — accepting/declining a quote that's a
// draft, already terminal, or expired must be rejected outright, unlike
// viewing it.
function assertRespondable(quote: InstanceType<typeof Quote>) {
    if (quote.status === "draft") throw new BadRequestError("This quote hasn't been sent yet.", "QUOTE_NOT_SENT");
    if (quote.status === "cancelled") throw new BadRequestError("This quote has been cancelled.", "QUOTE_CANCELLED");
    if (quote.status === "accepted") throw new BadRequestError("This quote has already been accepted.", "QUOTE_ACCEPTED");
    if (quote.status === "declined") throw new BadRequestError("This quote has already been declined.", "QUOTE_DECLINED");
    if (quote.status === "expired") throw new BadRequestError("This quote has expired.", "QUOTE_EXPIRED");
}

// GET /quotes/public/:token — the client-facing view. Marks the quote
// "viewed" on first open, same lazy-transition style as the expiry flip
// above. Succeeds for terminal statuses too, so the page can render the
// actual outcome (accepted/declined/expired/cancelled) instead of a dead
// end. Only client-safe fields go back — no createdBy, no internal
// chargeType/chargeRate/chargeAmount (see quoteModel.ts: those are the
// internal billing basis, never what prints for the client) — and no
// cancellationReason, which is an internal admin note, not a client-facing
// one (unlike declineReason, which the client themselves supplied).
export const getPublicQuote: MiddlewareFn = async (req, res) => {
    const quote = await findQuoteByToken(req.params.token);

    if (quote.status === "sent") {
        quote.status = "viewed";
        quote.viewedAt = quote.viewedAt ?? new Date();
        await quote.save();
    }

    const company = await Company.findById(quote.company).select("name phone").lean();

    res.status(StatusCodes.OK).json({
        success: true,
        quote: {
            quoteNumber: quote.quoteNumber,
            status: quote.status,
            title: quote.title,
            description: quote.description,
            client: quote.clientSnapshot,
            site: quote.siteSnapshot,
            items: quote.items,
            subtotal: quote.subtotal,
            taxRate: quote.taxRate,
            taxAmount: quote.taxAmount,
            total: quote.total,
            currency: quote.currency,
            validUntil: quote.validUntil,
            notes: quote.notes,
            terms: quote.terms,
            template: quote.templateSnapshot,
            sentAt: quote.sentAt,
            viewedAt: quote.viewedAt,
            acceptedAt: quote.acceptedAt,
            acceptedBy: quote.acceptedBy,
            declinedAt: quote.declinedAt,
            declinedBy: quote.declinedBy,
            declineReason: quote.declineReason,
        },
        company: company ? { name: company.name, phone: company.phone } : null,
    });
};

const respondSchema = z
    .object({
        action: z.enum(["accept", "decline"]),
        name: z.string().trim().min(1, "Name is required").max(150),
        email: z.string().trim().email("A valid email is required"),
        declineReason: z.string().trim().max(1000).optional(),
    })
    .strict();

// POST /quotes/public/:token/respond — the client accepting or declining.
export const respondToPublicQuote: MiddlewareFn = async (req, res) => {
    const data = parseOrThrow(respondSchema, req.body);
    const quote = await findQuoteByToken(req.params.token);
    assertRespondable(quote);

    if (data.action === "accept") {
        quote.status = "accepted";
        quote.acceptedAt = new Date();
        quote.acceptedBy = { name: data.name, email: data.email };
    } else {
        quote.status = "declined";
        quote.declinedAt = new Date();
        quote.declinedBy = { name: data.name, email: data.email };
        quote.declineReason = data.declineReason ?? "";
    }

    await quote.save();

    // Best-effort — the client's accept/decline must succeed even if this
    // internal notification fails to send.
    const [creator, company] = await Promise.all([
        User.findById(quote.createdBy).select("fullname email").lean(),
        Company.findById(quote.company).select("name emailSettings").lean(),
    ]);
    if (creator?.email) {
        sendQuoteResponseNotice({
            email: creator.email,
            fullname: creator.fullname ?? "there",
            quoteNumber: quote.quoteNumber,
            title: quote.title,
            clientName: quote.clientSnapshot?.name ?? "The client",
            accepted: data.action === "accept",
            declineReason: quote.declineReason || undefined,
            company: company ?? { name: "INPRN" },
        }).catch(err => console.error("sendQuoteResponseNotice failed:", err));
    }

    // Gated by the checkbox set at creation/edit time — not sent
    // unconditionally. Also best-effort: a failed thank-you email must
    // never make the client's own accept action look like it failed.
    const clientEmail = quote.clientSnapshot?.billingEmail;
    if (data.action === "accept" && quote.sendThankYouEmailOnAccept && clientEmail) {
        sendQuoteThankYouEmail({
            email: clientEmail,
            clientContactName: quote.clientSnapshot?.contactName,
            quoteNumber: quote.quoteNumber,
            title: quote.title,
            company: company ?? { name: "INPRN" },
            customMessage: quote.thankYouMessage || undefined,
        }).catch(err => console.error("sendQuoteThankYouEmail failed:", err));
    }

    res.status(StatusCodes.OK).json({ success: true, status: quote.status });
};
