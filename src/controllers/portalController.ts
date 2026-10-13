import { StatusCodes } from "http-status-codes";
import mongoose from "mongoose";
import { z } from "zod";
import { BadRequestError, NotFoundError, UnauthorizedError } from "../errors/customErrors.js";
import { MiddlewareFn } from "../interfaces/expresstype.js";
import Client from "../models/clientModel.js";
import Company from "../models/company.js";
import User from "../models/userModel.js";
import Job from "../models/jobModel.js";
import Quote from "../models/quoteModel.js";
import Invoice from "../models/invoiceModel.js";
import Site from "../models/siteModel.js";
import { sanitizeUser } from "../utils/tokenUtils.js";
import { toPortalBooking, toPortalQuote, toPortalInvoice, toPortalSite } from "../utils/portalSerializers.js";
import { assertRespondable, applyQuoteResponse } from "./quoteController.js";
import { buildInvoicePdfDocument } from "./invoiceController.js";

// GET /portal/me — proves the whole login -> authenticated-request loop
// actually works, and is the one place in this milestone that re-verifies
// a live session is still allowed to use the portal at all. Deliberately
// does a real DB lookup rather than trusting client_id out of the JWT: an
// already-issued access token can outlive the Client being deactivated or
// deleted after the fact, and this is what catches that rather than
// letting a stale token keep working until it naturally expires.
export const getPortalMe: MiddlewareFn = async (req, res) => {
    const client = await Client.findOne({
        _id: req.user.client_id,
        company: req.user.company_id,
        lifecycle: "client",
        status: "active",
        isDeleted: false,
    }).select("name");
    if (!client) {
        throw new UnauthorizedError("This client account is no longer active.");
    }

    const [user, company] = await Promise.all([
        User.findById(req.user.user_id),
        Company.findById(req.user.company_id).select("name logo"),
    ]);
    if (!user) throw new UnauthorizedError("Account not found.");

    res.status(StatusCodes.OK).json({
        success: true,
        user: sanitizeUser(user),
        client: { _id: client._id, name: client.name },
        company: company ? { name: company.name, logo: company.logo?.url ?? null } : null,
    });
};

function parsePagination(query: Record<string, string | undefined>) {
    const page = Math.max(1, parseInt(query.page ?? "1", 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(query.limit ?? "20", 10) || 20));
    return { page, limit, skip: (page - 1) * limit };
}

// Every handler below scopes by BOTH client (req.user.client_id, kept
// live by requireClientPermission) and company — never client alone, see
// the plan's tenant-isolation requirement. Job.company is a plain String
// (a pre-existing quirk, unlike every other model here), so it's compared
// via .toString() rather than as an ObjectId.

// ── Bookings (Job) ─────────────────────────────────────────────────────

// GET /portal/bookings?status=&page=&limit=
export const getPortalBookings: MiddlewareFn = async (req, res) => {
    const { status } = req.query as Record<string, string | undefined>;
    const { page, limit, skip } = parsePagination(req.query as Record<string, string | undefined>);
    const companyIdStr = req.user.company_id.toString();

    const query: Record<string, unknown> = {
        client: req.user.client_id,
        company: companyIdStr,
        isDeleted: false,
    };
    if (status && ["draft", "published", "completed", "cancelled"].includes(status)) {
        query.status = status;
    }

    // Newest first — same convention as Quotes (createdAt: -1) and Invoices
    // (issueDate: -1) below. A client with more than one page of history
    // never reaches page 2 from the UI (no pager in Bookings.tsx), so an
    // ascending sort buried every new booking behind all older ones the
    // moment a client passed ~20 jobs.
    const [jobs, total] = await Promise.all([
        Job.find(query).sort({ date: -1 }).skip(skip).limit(limit).lean(),
        Job.countDocuments(query),
    ]);

    res.status(StatusCodes.OK).json({
        success: true,
        bookings: jobs.map(toPortalBooking),
        total,
        totalPages: Math.ceil(total / limit),
        currentPage: page,
    });
};

// GET /portal/bookings/:id
export const getPortalBooking: MiddlewareFn = async (req, res) => {
    const job = await Job.findOne({
        _id: req.params.id,
        client: req.user.client_id,
        company: req.user.company_id.toString(),
        isDeleted: false,
    }).lean();
    if (!job) throw new NotFoundError("Booking not found.");

    res.status(StatusCodes.OK).json({ success: true, booking: toPortalBooking(job) });
};

// ── Quotes ──────────────────────────────────────────────────────────────

// GET /portal/quotes?status=&page=&limit=
export const getPortalQuotes: MiddlewareFn = async (req, res) => {
    const { status } = req.query as Record<string, string | undefined>;
    const { page, limit, skip } = parsePagination(req.query as Record<string, string | undefined>);
    const companyId = new mongoose.Types.ObjectId(req.user.company_id.toString());

    const query: Record<string, unknown> = {
        client: req.user.client_id,
        company: companyId,
        isDeleted: false,
    };
    if (status && ["sent", "viewed", "accepted", "declined", "expired"].includes(status)) {
        query.status = status;
    } else {
        // Drafts/cancelled quotes are internal-review state — never shown
        // to the client at all, same reasoning as getPublicQuote's token
        // flow (a draft has no token yet; cancelled was pulled back).
        query.status = { $in: ["sent", "viewed", "accepted", "declined", "expired"] };
    }

    const [quotes, total] = await Promise.all([
        Quote.find(query).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
        Quote.countDocuments(query),
    ]);

    res.status(StatusCodes.OK).json({
        success: true,
        quotes: quotes.map(toPortalQuote),
        total,
        totalPages: Math.ceil(total / limit),
        currentPage: page,
    });
};

async function findPortalQuote(req: Parameters<MiddlewareFn>[0]) {
    const quote = await Quote.findOne({
        _id: req.params.id,
        client: req.user.client_id,
        company: new mongoose.Types.ObjectId(req.user.company_id.toString()),
        isDeleted: false,
        status: { $in: ["sent", "viewed", "accepted", "declined", "expired"] },
    });
    if (!quote) throw new NotFoundError("Quote not found.");
    return quote;
}

// GET /portal/quotes/:id
export const getPortalQuote: MiddlewareFn = async (req, res) => {
    const quote = await findPortalQuote(req);

    if (quote.status === "sent") {
        quote.status = "viewed";
        quote.viewedAt = quote.viewedAt ?? new Date();
        await quote.save();
    }

    res.status(StatusCodes.OK).json({ success: true, quote: toPortalQuote(quote) });
};

const declineSchema = z.object({ declineReason: z.string().trim().max(1000).optional() }).strict();

// POST /portal/quotes/:id/accept — name/email come from the authenticated
// User's own account, not re-typed, unlike the public token flow which
// has no real identity to draw on.
export const acceptPortalQuote: MiddlewareFn = async (req, res) => {
    const quote = await findPortalQuote(req);
    assertRespondable(quote);

    const user = await User.findById(req.user.user_id);
    if (!user) throw new UnauthorizedError("Account not found.");

    await applyQuoteResponse(quote, { action: "accept", name: user.fullname, email: user.email });

    res.status(StatusCodes.OK).json({ success: true, status: quote.status });
};

// POST /portal/quotes/:id/decline
export const declinePortalQuote: MiddlewareFn = async (req, res) => {
    const parsed = declineSchema.safeParse(req.body);
    if (!parsed.success) throw new BadRequestError(parsed.error.issues.map(i => i.message).join(" "));

    const quote = await findPortalQuote(req);
    assertRespondable(quote);

    const user = await User.findById(req.user.user_id);
    if (!user) throw new UnauthorizedError("Account not found.");

    await applyQuoteResponse(quote, {
        action: "decline",
        name: user.fullname,
        email: user.email,
        declineReason: parsed.data.declineReason,
    });

    res.status(StatusCodes.OK).json({ success: true, status: quote.status });
};

// ── Invoices ────────────────────────────────────────────────────────────

// GET /portal/invoices?status=&page=&limit=
export const getPortalInvoices: MiddlewareFn = async (req, res) => {
    const { status } = req.query as Record<string, string | undefined>;
    const { page, limit, skip } = parsePagination(req.query as Record<string, string | undefined>);
    const companyId = new mongoose.Types.ObjectId(req.user.company_id.toString());

    const query: Record<string, unknown> = {
        client: req.user.client_id,
        company: companyId,
        isDeleted: false,
        status: { $in: ["sent", "paid", "cancelled"] },
    };
    if (status && ["sent", "paid", "cancelled"].includes(status)) {
        query.status = status;
    }

    const [invoiceDocs, total] = await Promise.all([
        Invoice.find(query).sort({ issueDate: -1 }).skip(skip).limit(limit),
        Invoice.countDocuments(query),
    ]);

    res.status(StatusCodes.OK).json({
        success: true,
        invoices: invoiceDocs.map(inv => toPortalInvoice(inv.toObject({ virtuals: true }))),
        total,
        totalPages: Math.ceil(total / limit),
        currentPage: page,
    });
};

async function findPortalInvoice(req: Parameters<MiddlewareFn>[0]) {
    const invoice = await Invoice.findOne({
        _id: req.params.id,
        client: req.user.client_id,
        company: new mongoose.Types.ObjectId(req.user.company_id.toString()),
        isDeleted: false,
        status: { $in: ["sent", "paid", "cancelled"] },
    });
    if (!invoice) throw new NotFoundError("Invoice not found.");
    return invoice;
}

// GET /portal/invoices/:id
export const getPortalInvoice: MiddlewareFn = async (req, res) => {
    const invoice = await findPortalInvoice(req);
    res.status(StatusCodes.OK).json({ success: true, invoice: toPortalInvoice(invoice.toObject({ virtuals: true })) });
};

// GET /portal/invoices/:id/pdf
export const downloadPortalInvoicePdf: MiddlewareFn = async (req, res) => {
    const invoice = await findPortalInvoice(req);
    const companyId = new mongoose.Types.ObjectId(req.user.company_id.toString());

    // persistTemplate: false — same choice downloadInvoicePdf makes for
    // its own staff-facing download; a portal download is a preview too,
    // never locks in a template on an unsent/unpaid invoice.
    const doc = await buildInvoicePdfDocument(invoice, companyId, { persistTemplate: false });

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${invoice.invoiceNumber}.pdf"`);
    doc.pipe(res);
    doc.end();
};

// ── Sites ───────────────────────────────────────────────────────────────
// Gated by booking:read (see clientPermissions.ts) — sites aren't a
// resource in the original spec's permission table, tied to bookings
// since a site only makes sense in that context.

// GET /portal/sites?status=&page=&limit=
export const getPortalSites: MiddlewareFn = async (req, res) => {
    const { status } = req.query as Record<string, string | undefined>;
    const { page, limit, skip } = parsePagination(req.query as Record<string, string | undefined>);
    const companyId = new mongoose.Types.ObjectId(req.user.company_id.toString());

    const query: Record<string, unknown> = {
        client: req.user.client_id,
        company: companyId,
        isDeleted: false,
    };
    if (status && ["active", "inactive"].includes(status)) {
        query.status = status;
    }

    const [sites, total] = await Promise.all([
        Site.find(query).sort({ name: 1 }).skip(skip).limit(limit).lean({ virtuals: true }),
        Site.countDocuments(query),
    ]);

    res.status(StatusCodes.OK).json({
        success: true,
        sites: sites.map(toPortalSite),
        total,
        totalPages: Math.ceil(total / limit),
        currentPage: page,
    });
};

// GET /portal/sites/:id
export const getPortalSite: MiddlewareFn = async (req, res) => {
    const site = await Site.findOne({
        _id: req.params.id,
        client: req.user.client_id,
        company: new mongoose.Types.ObjectId(req.user.company_id.toString()),
        isDeleted: false,
    }).lean({ virtuals: true });
    if (!site) throw new NotFoundError("Site not found.");

    res.status(StatusCodes.OK).json({ success: true, site: toPortalSite(site) });
};
