import { StatusCodes } from "http-status-codes";
import mongoose from "mongoose";
import { z } from "zod";
import { BadRequestError, NotFoundError } from "../errors/customErrors.js";
import { MiddlewareFn } from "../interfaces/expresstype.js";
import Client from "../models/clientModel.js";
import Job from "../models/jobModel.js";
import Invoice from "../models/invoiceModel.js";
import { toUtcDay } from "../utils/dates.js";

// Regex metacharacters in a search term would otherwise be interpreted as
// regex syntax rather than literal text (and a pathological pattern could
// be a cheap ReDoS vector) — escape before building the $regex.
const escapeRegExp = (input: string): string => input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const contactSchema = z.object({
    name: z.string().trim().optional(),
    role: z.string().trim().optional(),
    email: z.union([z.string().trim().email(), z.literal("")]).optional(),
    phone: z.string().trim().optional(),
    isPrimary: z.boolean().optional(),
});

const addressSchema = z.object({
    line1: z.string().trim().optional(),
    line2: z.string().trim().optional(),
    city: z.string().trim().optional(),
    county: z.string().trim().optional(),
    postcode: z.string().trim().optional(),
    country: z.string().trim().optional(),
});

// Only `name` is required — everything else defaults sensibly on the model,
// and the quick-create flow from the job-form typeahead only ever sends a name.
const createClientSchema = z
    .object({
        name: z.string().trim().min(1, "Client name is required").max(150),
        contacts: z.array(contactSchema).optional(),
        phone: z.string().trim().optional(),
        billingEmail: z.union([z.string().trim().email(), z.literal("")]).optional(),
        vatNumber: z.string().trim().optional(),
        address: addressSchema.optional(),
        defaultChargeType: z.enum(["hourly", "fixed"]).optional(),
        defaultChargeRate: z.number().min(0).optional(),
        paymentTermsDays: z.number().int().min(0).optional(),
        status: z.enum(["active", "inactive"]).optional(),
        notes: z.string().trim().max(2000).optional(),
    })
    .strict();

// PATCH — every field optional, unknown keys rejected (never spread req.body).
const updateClientSchema = createClientSchema.partial();

const statusSchema = z.object({ status: z.enum(["active", "inactive"]) }).strict();

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

const duplicateNameError = (name: string) => new BadRequestError(`A client called '${name}' already exists.`);

// GET /clients — also the job-form Client typeahead: ?search=tesco&status=active&limit=10
export const getAllClients: MiddlewareFn = async (req, res) => {
    const { search, status, page = "1", limit = "20" } = req.query as Record<string, string>;

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
    const skip = (pageNum - 1) * limitNum;

    const companyId = new mongoose.Types.ObjectId(req.user.company_id.toString());

    const match: Record<string, any> = { company: companyId, isDeleted: false };
    if (status && status !== "all" && ["active", "inactive"].includes(status)) {
        match.status = status;
    }
    if (search?.trim()) {
        const safe = escapeRegExp(search.trim());
        match.$or = [
            { name: { $regex: safe, $options: "i" } },
            { "contacts.name": { $regex: safe, $options: "i" } },
        ];
    }

    // Paginate BEFORE joining jobs/invoices — the $lookups below only ever
    // run against the current page's clients, not the whole collection.
    const [result] = await Client.aggregate([
        { $match: match },
        { $sort: { name: 1 } },
        {
            $facet: {
                data: [
                    { $skip: skip },
                    { $limit: limitNum },
                    {
                        $lookup: {
                            from: "jobs",
                            let: { clientId: "$_id" },
                            pipeline: [
                                { $match: { $expr: { $eq: ["$client", "$$clientId"] }, isDeleted: false } },
                                { $count: "count" },
                            ],
                            as: "jobStats",
                        },
                    },
                    {
                        $lookup: {
                            from: "invoices",
                            let: { clientId: "$_id" },
                            pipeline: [
                                {
                                    $match: {
                                        $expr: { $eq: ["$client", "$$clientId"] },
                                        isDeleted: false,
                                        status: { $ne: "cancelled" },
                                    },
                                },
                                { $group: { _id: null, total: { $sum: "$total" } } },
                            ],
                            as: "invoiceStats",
                        },
                    },
                    {
                        $addFields: {
                            jobCount: { $ifNull: [{ $first: "$jobStats.count" }, 0] },
                            totalInvoiced: { $ifNull: [{ $first: "$invoiceStats.total" }, 0] },
                        },
                    },
                    { $project: { jobStats: 0, invoiceStats: 0 } },
                ],
                totalCount: [{ $count: "count" }],
            },
        },
    ]);

    const clients = result?.data ?? [];
    const total = result?.totalCount?.[0]?.count ?? 0;

    res.status(StatusCodes.OK).json({
        success: true,
        clients,
        page: pageNum,
        limit: limitNum,
        total,
        totalPages: Math.ceil(total / limitNum),
    });
};

export const getClient: MiddlewareFn = async (req, res) => {
    const companyId = new mongoose.Types.ObjectId(req.user.company_id.toString());
    const id = req.params.id as string;

    if (!mongoose.Types.ObjectId.isValid(id)) {
        throw new NotFoundError("Client not found.");
    }

    const client = await Client.findOne({ _id: id, company: companyId, isDeleted: false }).lean();
    if (!client) throw new NotFoundError("Client not found.");

    const today = toUtcDay(new Date());

    // Job.company is schema-typed String (a pre-existing quirk elsewhere in
    // this codebase), unlike Client/Invoice's ObjectId — cast separately.
    const companyIdStr = companyId.toString();

    const [totalJobs, upcomingJobs, invoiceAgg, recentJobs] = await Promise.all([
        Job.countDocuments({ client: client._id, company: companyIdStr, isDeleted: false }),
        Job.countDocuments({
            client: client._id,
            company: companyIdStr,
            isDeleted: false,
            date: { $gte: today },
            status: { $ne: "cancelled" },
        }),
        // MongoDB can't see Mongoose virtuals (Invoice.balanceDue) — the
        // outstanding balance is computed here from persisted fields only.
        Invoice.aggregate([
            {
                $match: {
                    client: client._id,
                    company: companyId,
                    isDeleted: false,
                    status: { $ne: "cancelled" },
                },
            },
            {
                $group: {
                    _id: null,
                    totalInvoiced: { $sum: "$total" },
                    outstandingBalance: {
                        $sum: {
                            $cond: [
                                { $eq: ["$status", "sent"] },
                                { $max: [{ $subtract: ["$total", { $ifNull: ["$amountPaid", 0] }] }, 0] },
                                0,
                            ],
                        },
                    },
                },
            },
        ]),
        Job.find({ client: client._id, company: companyIdStr, isDeleted: false })
            .select("title date status")
            .sort({ date: -1 })
            .limit(10)
            .lean(),
    ]);

    res.status(StatusCodes.OK).json({
        success: true,
        client,
        stats: {
            totalJobs,
            upcomingJobs,
            totalInvoiced: invoiceAgg[0]?.totalInvoiced ?? 0,
            outstandingBalance: invoiceAgg[0]?.outstandingBalance ?? 0,
        },
        recentJobs,
    });
};

export const createClient: MiddlewareFn = async (req, res) => {
    const data = parseOrThrow(createClientSchema, req.body);

    let client;
    try {
        client = await Client.create({
            ...data,
            company: req.user.company_id,
            createdBy: req.user.user_id,
        });
    } catch (err: any) {
        if (err?.code === 11000) throw duplicateNameError(data.name);
        throw err;
    }

    res.status(StatusCodes.CREATED).json({ success: true, client });
};

export const updateClient: MiddlewareFn = async (req, res) => {
    const data = parseOrThrow(updateClientSchema, req.body);
    if (Object.keys(data).length === 0) {
        throw new BadRequestError("No valid fields provided.");
    }

    let client;
    try {
        client = await Client.findOneAndUpdate(
            { _id: req.params.id, company: req.user.company_id, isDeleted: false },
            { $set: data },
            { new: true, runValidators: true }
        );
    } catch (err: any) {
        if (err?.code === 11000) throw duplicateNameError(data.name ?? "");
        throw err;
    }

    if (!client) throw new NotFoundError("Client not found.");

    res.status(StatusCodes.OK).json({ success: true, client });
};

// Soft-delete only — refused outright if any job or invoice still
// references this client, so nothing is ever left pointing at a dead id.
export const deleteClient: MiddlewareFn = async (req, res) => {
    const companyId = req.user.company_id;
    const client = await Client.findOne({ _id: req.params.id, company: companyId, isDeleted: false });
    if (!client) throw new NotFoundError("Client not found.");

    const [jobCount, invoiceCount] = await Promise.all([
        // Job.company is schema-typed String, unlike Client/Invoice's ObjectId.
        Job.countDocuments({ client: client._id, company: companyId.toString(), isDeleted: false }),
        Invoice.countDocuments({ client: client._id, company: companyId, isDeleted: false }),
    ]);

    if (jobCount > 0 || invoiceCount > 0) {
        throw new BadRequestError(
            `This client has ${jobCount} job${jobCount === 1 ? "" : "s"} and ${invoiceCount} invoice${invoiceCount === 1 ? "" : "s"}. Set them to inactive instead.`
        );
    }

    client.isDeleted = true;
    await client.save();

    res.status(StatusCodes.OK).json({ success: true, msg: "Client deleted." });
};

// Toggles the commercial relationship without touching history — an
// inactive client stays attached to its past jobs/invoices and can be
// reactivated, it just drops out of the active-only job typeahead.
export const archiveClient: MiddlewareFn = async (req, res) => {
    const data = parseOrThrow(statusSchema, req.body);

    const client = await Client.findOneAndUpdate(
        { _id: req.params.id, company: req.user.company_id, isDeleted: false },
        { status: data.status },
        { new: true }
    );
    if (!client) throw new NotFoundError("Client not found.");

    res.status(StatusCodes.OK).json({ success: true, client });
};
