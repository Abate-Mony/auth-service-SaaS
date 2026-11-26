import { StatusCodes } from "http-status-codes";
import mongoose from "mongoose";
import { z } from "zod";
import { BadRequestError, NotFoundError } from "../errors/customErrors.js";
import { MiddlewareFn } from "../interfaces/expresstype.js";
import JobTemplate, { TEMPLATE_ICONS } from "../models/JobTemplate.js";
import Job from "../models/jobModel.js";
import { compareTemplates, templateFieldsFromJob } from "../utils/jobTemplateFields.js";

const MAX_TEMPLATES = 100;

const parseOrThrow = <T>(schema: z.ZodSchema<T>, body: unknown): T => {
    try {
        return schema.parse(body);
    } catch (err) {
        if (err instanceof z.ZodError) {
            throw new BadRequestError(
                err.issues.map(i => `${i.path.join(".") || "value"}: ${i.message}`).join("; ")
            );
        }
        throw err;
    }
};

const time = z.union([z.literal(""), z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:mm")]);
const money = z.coerce.number().min(0).max(100000);

const templateSchema = z.object({
    name: z.string().trim().min(1, "Give the template a name").max(80),
    summary: z.string().trim().max(140).default(""),
    icon: z.enum(TEMPLATE_ICONS).default("sparkles"),
    title: z.string().trim().min(1, "Job title is required").max(200),
    description: z.string().trim().max(5000).default(""),
    priority: z.enum(["low", "medium", "high", "urgent"]).default("medium"),
    startTime: time.default(""),
    endTime: time.default(""),
    requiredWorkers: z.coerce.number().int().min(1).max(50).default(1),
    payRate: money.default(0),
    chargeType: z.enum(["hourly", "fixed"]).default("hourly"),
    chargeRate: money.default(0),
    chargeAmount: money.default(0),
    instructions: z.string().trim().max(5000).default(""),
    notes: z.string().trim().max(5000).default(""),
    checklist: z.array(z.object({ text: z.string().trim().min(1).max(200) })).max(100).default([]),
    openToClaims: z.boolean().default(false),
    requiresApproval: z.boolean().default(true),
    autoAccept: z.boolean().default(false),
}).strict();

/** Times come as a pair or not at all; the price field that isn't used is zeroed. */
const normalise = <T extends Partial<z.infer<typeof templateSchema>>>(data: T): T => {
    if (!!data.startTime !== !!data.endTime) {
        throw new BadRequestError("Set both a start and finish time, or leave both empty.");
    }
    if (data.startTime && data.startTime === data.endTime) {
        throw new BadRequestError("Start and finish time can't be the same.");
    }
    if (data.chargeType === "hourly") data.chargeAmount = 0;
    if (data.chargeType === "fixed") data.chargeRate = 0;
    return data;
};

const companyOf = (req: any) => new mongoose.Types.ObjectId(req.user.company_id.toString());

const idOrThrow = (id: unknown) => {
    if (typeof id !== "string" || !mongoose.Types.ObjectId.isValid(id)) throw new BadRequestError("Invalid template id.");
    return id;
};

const findOwnTemplate = async (req: any) => {
    const template = await JobTemplate.findOne({ _id: idOrThrow(req.params.id), company: companyOf(req), isDeleted: false });
    if (!template) throw new NotFoundError("Template not found.");
    return template;
};

const duplicateName = (err: any, name: string) => {
    if (err?.code === 11000) return new BadRequestError(`You already have a template called "${name}".`);
    return err;
};

const assertRoom = async (company: mongoose.Types.ObjectId) => {
    const count = await JobTemplate.countDocuments({ company, isDeleted: false });
    if (count >= MAX_TEMPLATES) throw new BadRequestError(`You can have up to ${MAX_TEMPLATES} templates. Delete one you no longer use first.`);
};

// GET /job-templates — most used first.
export const getJobTemplates: MiddlewareFn = async (req, res) => {
    const templates = await JobTemplate.find({ company: companyOf(req), isDeleted: false }).lean();
    templates.sort(compareTemplates);
    res.status(StatusCodes.OK).json({ success: true, templates });
};

export const getJobTemplate: MiddlewareFn = async (req, res) => {
    const template = await findOwnTemplate(req);
    res.status(StatusCodes.OK).json({ success: true, template });
};

export const createJobTemplate: MiddlewareFn = async (req, res) => {
    const data = normalise(parseOrThrow(templateSchema, req.body));
    const company = companyOf(req);
    await assertRoom(company);
    try {
        const template = await JobTemplate.create({ ...data, company, createdBy: req.user.user_id });
        res.status(StatusCodes.CREATED).json({ success: true, template });
    } catch (err) {
        throw duplicateName(err, data.name);
    }
};

export const updateJobTemplate: MiddlewareFn = async (req, res) => {
    const template = await findOwnTemplate(req);
    const data = parseOrThrow(templateSchema.partial(), req.body);
    if (!Object.keys(data).length) throw new BadRequestError("No valid fields provided.");
    // Check the pair/price rules against the merged result, not just the patch.
    const merged = normalise({ ...template.toObject(), ...data } as any);
    template.set({ ...data, chargeRate: merged.chargeRate, chargeAmount: merged.chargeAmount });
    try {
        await template.save();
    } catch (err) {
        throw duplicateName(err, template.name);
    }
    res.status(StatusCodes.OK).json({ success: true, template });
};

// Soft delete: jobs made from it are unaffected (they never linked to it).
export const deleteJobTemplate: MiddlewareFn = async (req, res) => {
    const template = await findOwnTemplate(req);
    template.isDeleted = true;
    await template.save();
    res.status(StatusCodes.OK).json({ success: true, msg: "Template deleted." });
};

// POST /job-templates/from-job/:jobId { name, summary?, icon? }
export const createTemplateFromJob: MiddlewareFn = async (req, res) => {
    const company = companyOf(req);
    const jobId = req.params.jobId;
    if (!mongoose.Types.ObjectId.isValid(String(jobId))) throw new BadRequestError("Invalid job id.");
    // Job.company is stored as a string.
    const job = await Job.findOne({ _id: jobId, company: String(req.user.company_id), isDeleted: false }).lean();
    if (!job) throw new NotFoundError("Job not found.");

    const meta = parseOrThrow(
        z.object({
            name: z.string().trim().min(1, "Give the template a name").max(80),
            summary: z.string().trim().max(140).default(""),
            icon: z.enum(TEMPLATE_ICONS).default("sparkles"),
        }),
        req.body
    );
    await assertRoom(company);
    const fields = templateFieldsFromJob(job);
    if (!fields.title) throw new BadRequestError("This job has no title to copy.");
    try {
        const template = await JobTemplate.create({ ...fields, ...meta, company, createdBy: req.user.user_id });
        res.status(StatusCodes.CREATED).json({ success: true, template });
    } catch (err) {
        throw duplicateName(err, meta.name);
    }
};

// POST /job-templates/:id/used — called after a job is created from it, so
// the picker can put the most-used templates first.
export const markJobTemplateUsed: MiddlewareFn = async (req, res) => {
    await JobTemplate.updateOne(
        { _id: idOrThrow(req.params.id), company: companyOf(req), isDeleted: false },
        { $inc: { useCount: 1 }, $set: { lastUsedAt: new Date() } }
    );
    res.status(StatusCodes.OK).json({ success: true });
};
