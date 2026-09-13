import { StatusCodes } from "http-status-codes";
import mongoose from "mongoose";
import { z } from "zod";
import { BadRequestError, NotFoundError } from "../errors/customErrors.js";
import { MiddlewareFn } from "../interfaces/expresstype.js";
import Site from "../models/siteModel.js";
import Client from "../models/clientModel.js";
import Job from "../models/jobModel.js";
import { formatAddress } from "../utils/formatAddress.js";

// Same as clientController.ts's own copy — escapes regex metacharacters in
// a search term before it goes into a $regex, both for correctness and to
// avoid a cheap ReDoS vector.
const escapeRegExp = (input: string): string => input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const addressSchema = z.object({
    line1: z.string().trim().optional(),
    line2: z.string().trim().optional(),
    city: z.string().trim().optional(),
    county: z.string().trim().optional(),
    postcode: z.string().trim().optional(),
    country: z.string().trim().optional(),
});

const contactSchema = z.object({
    name: z.string().trim().optional(),
    phone: z.string().trim().optional(),
    email: z.union([z.string().trim().email(), z.literal("")]).optional(),
});

const coordinatesSchema = z.object({
    lat: z.number().min(-90).max(90),
    lng: z.number().min(-180).max(180),
});

// `client` is required to create a Site but not on update (a Site can't
// move between clients after the fact — see updateSite).
const createSiteSchema = z
    .object({
        name: z.string().trim().min(1, "Site name is required").max(150),
        client: z.string().min(1, "Client is required"),
        address: addressSchema.optional(),
        coordinates: coordinatesSchema.optional(),
        geofenceMode: z.enum(["off", "warn", "enforce"]).nullable().optional(),
        geofenceRadiusMeters: z.number().int().positive().max(5000).nullable().optional(),
        contact: contactSchema.optional(),
        instructions: z.string().trim().max(2000).optional(),
        accessInstructions: z.string().trim().max(1000).optional(),
        parkingInstructions: z.string().trim().max(1000).optional(),
    })
    .strict();

// PATCH — every field optional except `client`, which is intentionally
// excluded: a Site belonging to a different Client is a different
// workplace, not an edit. Unknown keys are rejected (never spread req.body).
const updateSiteSchema = createSiteSchema.omit({ client: true }).partial();

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

const duplicateNameError = (name: string) => new BadRequestError(`A site called '${name}' already exists for this client.`);

// Verifies the client belongs to this company — never trusts a client id
// just because the frontend only ever shows valid ones.
const resolveSiteClient = async (clientId: unknown, companyId: mongoose.Types.ObjectId) => {
    if (typeof clientId !== "string" || !mongoose.Types.ObjectId.isValid(clientId)) {
        throw new BadRequestError("Invalid client id.");
    }
    const client = await Client.findOne({ _id: clientId, company: companyId, isDeleted: false });
    if (!client) throw new BadRequestError("Client not found.");
    return client;
};

// GET /sites — also the job-form Site typeahead: ?client=&status=active&search=
export const getAllSites: MiddlewareFn = async (req, res) => {
    const { client, status, search, page = "1", limit = "20" } = req.query as Record<string, string>;

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
    const skip = (pageNum - 1) * limitNum;

    const companyId = new mongoose.Types.ObjectId(req.user.company_id.toString());

    const match: Record<string, any> = { company: companyId, isDeleted: false };
    if (client) {
        if (!mongoose.Types.ObjectId.isValid(client)) throw new BadRequestError("Invalid client id.");
        match.client = new mongoose.Types.ObjectId(client);
    }
    if (status && status !== "all" && ["active", "inactive"].includes(status)) {
        match.status = status;
    }
    if (search?.trim()) {
        const safe = escapeRegExp(search.trim());
        match.$or = [
            { name: { $regex: safe, $options: "i" } },
            { "address.line1": { $regex: safe, $options: "i" } },
            { "address.city": { $regex: safe, $options: "i" } },
            { "address.postcode": { $regex: safe, $options: "i" } },
        ];
    }

    const [sites, total] = await Promise.all([
        Site.find(match)
            .populate("client", "name")
            .sort({ name: 1 })
            .skip(skip)
            .limit(limitNum)
            .lean(),
        Site.countDocuments(match),
    ]);

    res.status(StatusCodes.OK).json({
        success: true,
        sites: sites.map(s => ({ ...s, formattedAddress: formatAddress(s.address) })),
        page: pageNum,
        limit: limitNum,
        total,
        totalPages: Math.ceil(total / limitNum),
    });
};

export const getSite: MiddlewareFn = async (req, res) => {
    const companyId = new mongoose.Types.ObjectId(req.user.company_id.toString());
    const id = req.params.id as string;

    if (!mongoose.Types.ObjectId.isValid(id)) throw new NotFoundError("Site not found.");

    const site = await Site.findOne({ _id: id, company: companyId, isDeleted: false })
        .populate("client", "name status")
        .lean();
    if (!site) throw new NotFoundError("Site not found.");

    // Job.company is schema-typed String (a pre-existing quirk elsewhere in
    // this codebase), unlike Site's ObjectId — cast separately.
    const companyIdStr = companyId.toString();
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const [upcomingJobs, recentJobs] = await Promise.all([
        Job.find({ site: site._id, company: companyIdStr, isDeleted: false, date: { $gte: today }, status: { $ne: "cancelled" } })
            .select("title date startTime endTime status")
            .sort({ date: 1 })
            .limit(10)
            .lean(),
        Job.find({ site: site._id, company: companyIdStr, isDeleted: false, date: { $lt: today } })
            .select("title date startTime endTime status")
            .sort({ date: -1 })
            .limit(10)
            .lean(),
    ]);

    res.status(StatusCodes.OK).json({
        success: true,
        site: { ...site, formattedAddress: formatAddress(site.address) },
        upcomingJobs,
        recentJobs,
    });
};

export const createSite: MiddlewareFn = async (req, res) => {
    const data = parseOrThrow(createSiteSchema, req.body);
    const companyId = new mongoose.Types.ObjectId(req.user.company_id.toString());

    const clientDoc = await resolveSiteClient(data.client, companyId);

    let site;
    try {
        site = await Site.create({
            ...data,
            client: clientDoc._id,
            company: companyId,
            createdBy: req.user.user_id,
        });
    } catch (err: any) {
        if (err?.code === 11000) throw duplicateNameError(data.name);
        throw err;
    }

    res.status(StatusCodes.CREATED).json({
        success: true,
        site: { ...site.toObject(), formattedAddress: formatAddress(site.address) },
    });
};

export const updateSite: MiddlewareFn = async (req, res) => {
    const data = parseOrThrow(updateSiteSchema, req.body);
    if (Object.keys(data).length === 0) {
        throw new BadRequestError("No valid fields provided.");
    }

    let site;
    try {
        site = await Site.findOneAndUpdate(
            { _id: req.params.id, company: req.user.company_id, isDeleted: false },
            { $set: data },
            { new: true, runValidators: true }
        );
    } catch (err: any) {
        if (err?.code === 11000) throw duplicateNameError(data.name ?? "");
        throw err;
    }

    if (!site) throw new NotFoundError("Site not found.");

    res.status(StatusCodes.OK).json({
        success: true,
        site: { ...site.toObject(), formattedAddress: formatAddress(site.address) },
    });
};

// Deactivate/reactivate — never a destructive delete once a Site may be
// referenced by historical Jobs (their siteSnapshot/location/address stay
// intact regardless; only new-job selection is affected — see
// jobController.ts's resolveJobSite, which requires status "active").
export const updateSiteStatus: MiddlewareFn = async (req, res) => {
    const data = parseOrThrow(statusSchema, req.body);

    const site = await Site.findOneAndUpdate(
        { _id: req.params.id, company: req.user.company_id, isDeleted: false },
        { status: data.status },
        { new: true }
    );
    if (!site) throw new NotFoundError("Site not found.");

    res.status(StatusCodes.OK).json({
        success: true,
        site: { ...site.toObject(), formattedAddress: formatAddress(site.address) },
    });
};
