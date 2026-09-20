// controllers/externalController.ts
//
// The actual endpoints an external integration (a company's own booking
// website, etc.) calls — authenticated by API key (see
// middleware/apiKeyAuthMiddleware.ts), never a user session. Two safety
// rules that apply to every handler here:
//
//   1. Every job this creates lands as status "draft" — never published,
//      never live, never assigned a worker. A manager has to review and
//      publish it from the normal app, same "external/AI input proposes,
//      a human confirms" principle as the job-draft assistant and quotes.
//   2. Every query is scoped to req.externalAuth.companyId, taken from the
//      verified API key — never a value the request body/query supplies.
import { StatusCodes } from "http-status-codes";
import mongoose from "mongoose";
import { z } from "zod";
import { BadRequestError, NotFoundError } from "../errors/customErrors.js";
import { MiddlewareFn } from "../interfaces/expresstype.js";
import { getExternalAuth } from "../middleware/apiKeyAuthMiddleware.js";
import Job from "../models/jobModel.js";
import JobAssignment from "../models/JobAssignment.js";
import Client from "../models/clientModel.js";
import Site from "../models/siteModel.js";
import Company from "../models/company.js";
import { toUtcDay } from "../utils/dates.js";
import { assertCanCreateJob } from "../utils/planLimits.js";

const parseOrThrow = <T>(schema: z.ZodSchema<T>, body: unknown): T => {
  try {
    return schema.parse(body);
  } catch (err) {
    if (err instanceof z.ZodError) {
      throw new BadRequestError(err.issues[0]?.message ?? "Invalid request.");
    }
    throw err;
  }
};

// Same calc as jobController.ts's own jobDurationMinutes (not exported from
// there, so duplicated rather than importing controller-to-controller).
const jobDurationMinutes = (startTime: string, endTime: string): number => {
  const [sh, sm] = startTime.split(":").map(Number);
  const [eh, em] = endTime.split(":").map(Number);
  if ([sh, sm, eh, em].some(n => Number.isNaN(n))) {
    throw new BadRequestError("Invalid start or end time — expected HH:mm");
  }
  let minutes = eh * 60 + em - (sh * 60 + sm);
  if (minutes <= 0) minutes += 24 * 60;
  return minutes;
};

// ── GET /external/clients — lets an integration resolve a client name it
// already knows to the id this API actually needs. ──────────────────────
export const getExternalClients: MiddlewareFn = async (req, res) => {
  const { companyId } = getExternalAuth(req);
  const { search } = req.query as { search?: string };

  const match: Record<string, any> = { company: companyId, isDeleted: false, status: "active" };
  if (search?.trim()) {
    const safe = search.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    match.name = { $regex: safe, $options: "i" };
  }

  const clients = await Client.find(match).select("name").sort({ name: 1 }).limit(100).lean();
  res.status(StatusCodes.OK).json({
    success: true,
    clients: clients.map(c => ({ id: String(c._id), name: c.name })),
  });
};

// ── GET /external/sites — sites for one of this company's clients. ──────
export const getExternalSites: MiddlewareFn = async (req, res) => {
  const { companyId } = getExternalAuth(req);
  const { clientId } = req.query as { clientId?: string };
  if (!clientId || !mongoose.Types.ObjectId.isValid(clientId)) {
    throw new BadRequestError("A valid clientId query param is required.");
  }

  const sites = await Site.find({ company: companyId, client: clientId, isDeleted: false, status: "active" })
    .select("name address")
    .sort({ name: 1 })
    .limit(100)
    .lean();

  res.status(StatusCodes.OK).json({
    success: true,
    sites: sites.map((s: any) => ({ id: String(s._id), name: s.name })),
  });
};

const dateRangeQuerySchema = z
  .object({
    dateFrom: z.string().optional(),
    dateTo: z.string().optional(),
    status: z.enum(["draft", "published", "completed", "cancelled"]).optional(),
    clientId: z.string().optional(),
  })
  .strict();

// ── GET /external/schedule — the calendar/schedule read side. Same
// field-whitelisting principle as the internal AI assistant's own job
// query: a hand-picked shape, never a raw document. ──────────────────────
export const getExternalSchedule: MiddlewareFn = async (req, res) => {
  const { companyId } = getExternalAuth(req);
  const data = parseOrThrow(dateRangeQuerySchema, req.query);

  const match: Record<string, any> = { company: companyId, isDeleted: false, isTemplate: false };
  if (data.status) match.status = data.status;
  if (data.clientId) {
    if (!mongoose.Types.ObjectId.isValid(data.clientId)) throw new BadRequestError("Invalid clientId.");
    match.client = data.clientId;
  }
  const dateFilter: Record<string, Date> = {};
  if (data.dateFrom) dateFilter.$gte = toUtcDay(data.dateFrom);
  if (data.dateTo) dateFilter.$lte = toUtcDay(data.dateTo);
  if (Object.keys(dateFilter).length) match.date = dateFilter;

  const jobs = await Job.find(match)
    .populate("client", "name")
    .populate("site", "name")
    .select("title date startTime endTime status requiredWorkers client site externalReference")
    .sort({ date: 1 })
    .limit(500)
    .lean();

  // Staffing isn't a field on Job — a worker being on a shift is a separate
  // JobAssignment document (same fix as the AI data assistant's own
  // query_jobs tool needed after this exact mistake shipped there once).
  const jobIds = jobs.map((j: any) => j._id);
  const assignmentCounts = jobIds.length
    ? await JobAssignment.aggregate([
        { $match: { job: { $in: jobIds }, isDeleted: false, status: { $nin: ["declined", "cancelled"] } } },
        { $group: { _id: "$job", count: { $sum: 1 } } },
      ])
    : [];
  const countByJob = new Map(assignmentCounts.map((a: any) => [String(a._id), a.count]));

  res.status(StatusCodes.OK).json({
    success: true,
    jobs: jobs.map((j: any) => ({
      id: String(j._id),
      title: j.title,
      date: j.date ? new Date(j.date).toISOString().slice(0, 10) : null,
      startTime: j.startTime,
      endTime: j.endTime,
      status: j.status,
      client: j.client?.name ?? null,
      site: j.site?.name ?? null,
      requiredWorkers: j.requiredWorkers,
      assignedWorkers: countByJob.get(String(j._id)) ?? 0,
      externalReference: j.externalReference ?? null,
    })),
  });
};

const createExternalJobSchema = z
  .object({
    clientId: z.string().refine(v => mongoose.Types.ObjectId.isValid(v), "A valid clientId is required."),
    siteId: z.string().optional(),
    title: z.string().trim().min(1, "Title is required").max(200),
    description: z.string().trim().max(2000).optional(),
    date: z.string().trim().min(1, "Date is required"), // YYYY-MM-DD
    startTime: z.string().trim().regex(/^\d{2}:\d{2}$/, "startTime must be HH:mm"),
    endTime: z.string().trim().regex(/^\d{2}:\d{2}$/, "endTime must be HH:mm"),
    location: z.string().trim().max(300).optional(),
    address: z.string().trim().max(500).optional(),
    requiredWorkers: z.number().int().min(1).max(200).optional(),
    notes: z.string().trim().max(2000).optional(),
    // The caller's own booking id — echoed back on every read/write so
    // their system never has to persist ours.
    externalReference: z.string().trim().max(200).optional(),
  })
  .strict();

// ── POST /external/jobs — the write side. Always creates a DRAFT; see this
// file's header for why. ─────────────────────────────────────────────────
export const createExternalJob: MiddlewareFn = async (req, res) => {
  const { companyId, apiKeyId } = getExternalAuth(req);
  const data = parseOrThrow(createExternalJobSchema, req.body);

  await assertCanCreateJob(companyId);

  const [company, client] = await Promise.all([
    Company.findById(companyId).select("owner"),
    Client.findOne({ _id: data.clientId, company: companyId, isDeleted: false, status: "active" }),
  ]);
  if (!company) throw new NotFoundError("Company not found.");
  if (!client) throw new BadRequestError("Client not found, inactive, or doesn't belong to this company.");

  let site = null;
  if (data.siteId) {
    if (!mongoose.Types.ObjectId.isValid(data.siteId)) throw new BadRequestError("Invalid siteId.");
    site = await Site.findOne({ _id: data.siteId, company: companyId, client: client._id, isDeleted: false, status: "active" });
    if (!site) throw new BadRequestError("Site not found, inactive, or doesn't belong to this client.");
  }

  if (!site && !data.location) {
    throw new BadRequestError("Provide either a siteId or a location for a one-off address.");
  }

  const jobDate = toUtcDay(data.date);
  const minutes = jobDurationMinutes(data.startTime, data.endTime);

  const job = await Job.create({
    company: companyId.toString(),
    client: client._id,
    site: site?._id ?? null,
    siteSnapshot: site
      ? {
          name: site.name,
          contact: { name: site.contact?.name ?? "", phone: site.contact?.phone ?? "", email: site.contact?.email ?? "" },
          accessInstructions: site.accessInstructions ?? "",
          parkingInstructions: site.parkingInstructions ?? "",
        }
      : undefined,
    title: data.title,
    // Job.description is required + non-empty — an external caller
    // shouldn't be forced to write one just to book a shift, so this
    // falls back to the title rather than erroring.
    description: data.description?.trim() || data.title,
    location: site ? site.address?.line1 ?? site.name : data.location,
    address: site ? "" : data.address ?? "",
    date: jobDate,
    startTime: data.startTime,
    endTime: data.endTime,
    minutes,
    status: "draft",
    requiredWorkers: data.requiredWorkers ?? 1,
    notes: data.notes ?? "",
    createdBy: company.owner,
    createdViaApiKey: apiKeyId,
    externalReference: data.externalReference ?? null,
  });

  res.status(StatusCodes.CREATED).json({
    success: true,
    job: {
      id: String(job._id),
      title: job.title,
      date: job.date.toISOString().slice(0, 10),
      startTime: job.startTime,
      endTime: job.endTime,
      status: job.status,
      externalReference: job.externalReference,
    },
  });
};
