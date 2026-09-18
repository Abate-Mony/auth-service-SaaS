// services/ai/dataAssistantTools.ts
//
// Read-only, company-scoped query tools for the admin/manager data-assistant
// chat. Safety model (see AGENTS discussion this was built from):
//
//   1. Every tool's `run` builds its own hand-picked result object — never a
//      raw Mongo document spread. A field that isn't explicitly listed below
//      (password hashes, NI numbers, bank details, DBS numbers, home
//      addresses) physically cannot reach the model, regardless of what a
//      user asks the chat for.
//   2. `companyId` is bound into the tool via closure by dataAssistantChat.ts
//      — it is never a parameter the model can supply, so there is no way
//      for a prompt to ask the assistant to look at another company's data.
//   3. Every query is read-only (.find()/.aggregate() only). No tool here
//      can create, update, or delete anything.
//   4. List results are capped (see RESULT_CAP) to keep token cost and
//      response time predictable regardless of what's asked.
import { z } from "zod/v4";
import mongoose from "mongoose";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";

import Job from "../../models/jobModel.js";
import Invoice from "../../models/invoiceModel.js";
import Quote from "../../models/quoteModel.js";
import Client from "../../models/clientModel.js";
import UserModel from "../../models/userModel.js";

const RESULT_CAP = 25;

const dateRangeShape = {
  dateFrom: z.string().optional().describe("Inclusive start date, YYYY-MM-DD."),
  dateTo: z.string().optional().describe("Inclusive end date, YYYY-MM-DD."),
};

const parseDateRange = (dateFrom?: string, dateTo?: string) => {
  const range: Record<string, Date> = {};
  if (dateFrom && !isNaN(Date.parse(dateFrom))) range.$gte = new Date(dateFrom);
  if (dateTo && !isNaN(Date.parse(dateTo))) range.$lte = new Date(`${dateTo}T23:59:59.999Z`);
  return Object.keys(range).length ? range : undefined;
};

export function buildDataAssistantTools(companyId: string) {
  const companyObjectId = new mongoose.Types.ObjectId(companyId);

  const queryJobs = betaZodTool({
    name: "query_jobs",
    description:
      "Search this company's jobs (shifts). Returns a count and up to 25 matching jobs with title, date, time, status, client, and site — no worker personal data.",
    inputSchema: z.object({
      status: z.enum(["draft", "published", "in-progress", "completed", "cancelled"]).optional(),
      clientName: z.string().optional().describe("Filter to jobs for a client whose name contains this text."),
      ...dateRangeShape,
    }),
    run: async ({ status, clientName, dateFrom, dateTo }) => {
      const match: Record<string, any> = { company: companyId, isDeleted: false, isTemplate: false };
      if (status) match.status = status;
      const dateRange = parseDateRange(dateFrom, dateTo);
      if (dateRange) match.date = dateRange;

      let jobs = await Job.find(match)
        .populate("client", "name")
        .populate("site", "name")
        .select("title date startTime endTime status requiredWorkers workers client site")
        .sort({ date: -1 })
        .limit(200)
        .lean();

      if (clientName) {
        const needle = clientName.toLowerCase();
        jobs = jobs.filter((j: any) => (j.client?.name ?? "").toLowerCase().includes(needle));
      }

      const total = jobs.length;
      const items = jobs.slice(0, RESULT_CAP).map((j: any) => ({
        title: j.title,
        date: j.date ? new Date(j.date).toISOString().slice(0, 10) : null,
        startTime: j.startTime,
        endTime: j.endTime,
        status: j.status,
        client: j.client?.name ?? null,
        site: j.site?.name ?? null,
        requiredWorkers: j.requiredWorkers,
        assignedWorkers: Array.isArray(j.workers) ? j.workers.length : 0,
      }));

      return JSON.stringify({ totalMatched: total, shown: items.length, jobs: items });
    },
  });

  const queryInvoices = betaZodTool({
    name: "query_invoices",
    description:
      "Search this company's invoices. Returns a count, total/outstanding sums, and up to 25 matching invoices — invoice number, client name, status, amounts, due date. No client contact details.",
    inputSchema: z.object({
      status: z.enum(["draft", "sent", "paid", "cancelled"]).optional(),
      overdueOnly: z.boolean().optional().describe("Only invoices past their due date with an outstanding balance."),
      clientName: z.string().optional(),
      ...dateRangeShape,
    }),
    run: async ({ status, overdueOnly, clientName, dateFrom, dateTo }) => {
      const match: Record<string, any> = { company: companyObjectId, isDeleted: false };
      if (status) match.status = status;
      const dateRange = parseDateRange(dateFrom, dateTo);
      if (dateRange) match.issueDate = dateRange;

      let invoices = await Invoice.find(match)
        .select("invoiceNumber clientSnapshot status total amountPaid dueDate issueDate")
        .sort({ issueDate: -1 })
        .limit(500)
        .lean();

      const now = new Date();
      if (overdueOnly) {
        invoices = invoices.filter(
          (inv: any) =>
            inv.status === "sent" &&
            inv.dueDate &&
            new Date(inv.dueDate) < now &&
            (inv.amountPaid ?? 0) < (inv.total ?? 0)
        );
      }
      if (clientName) {
        const needle = clientName.toLowerCase();
        invoices = invoices.filter((inv: any) => (inv.clientSnapshot?.name ?? "").toLowerCase().includes(needle));
      }

      const total = invoices.length;
      const totalValue = invoices.reduce((s, inv: any) => s + (inv.total ?? 0), 0);
      const outstanding = invoices.reduce((s, inv: any) => {
        const isOverdueOrSent = inv.status === "sent";
        return isOverdueOrSent ? s + Math.max(0, (inv.total ?? 0) - (inv.amountPaid ?? 0)) : s;
      }, 0);

      const items = invoices.slice(0, RESULT_CAP).map((inv: any) => ({
        invoiceNumber: inv.invoiceNumber,
        client: inv.clientSnapshot?.name ?? null,
        status: inv.status,
        total: inv.total,
        amountPaid: inv.amountPaid ?? 0,
        balanceDue: Math.max(0, (inv.total ?? 0) - (inv.amountPaid ?? 0)),
        dueDate: inv.dueDate ? new Date(inv.dueDate).toISOString().slice(0, 10) : null,
        isOverdue: inv.status === "sent" && inv.dueDate ? new Date(inv.dueDate) < now : false,
      }));

      return JSON.stringify({
        totalMatched: total,
        shown: items.length,
        totalValue: Number(totalValue.toFixed(2)),
        outstandingBalance: Number(outstanding.toFixed(2)),
        invoices: items,
      });
    },
  });

  const queryQuotes = betaZodTool({
    name: "query_quotes",
    description:
      "Search this company's quotes. Returns a count and up to 25 matching quotes — quote number, client, status, total, valid-until date.",
    inputSchema: z.object({
      status: z.enum(["draft", "sent", "viewed", "accepted", "declined", "expired", "cancelled"]).optional(),
      clientName: z.string().optional(),
      ...dateRangeShape,
    }),
    run: async ({ status, clientName, dateFrom, dateTo }) => {
      const match: Record<string, any> = { company: companyObjectId, isDeleted: false };
      if (status) match.status = status;
      const dateRange = parseDateRange(dateFrom, dateTo);
      if (dateRange) match.createdAt = dateRange;

      let quotes = await Quote.find(match)
        .select("quoteNumber clientSnapshot status total validUntil")
        .sort({ createdAt: -1 })
        .limit(500)
        .lean();

      if (clientName) {
        const needle = clientName.toLowerCase();
        quotes = quotes.filter((q: any) => (q.clientSnapshot?.name ?? "").toLowerCase().includes(needle));
      }

      const total = quotes.length;
      const items = quotes.slice(0, RESULT_CAP).map((q: any) => ({
        quoteNumber: q.quoteNumber,
        client: q.clientSnapshot?.name ?? null,
        status: q.status,
        total: q.total,
        validUntil: q.validUntil ? new Date(q.validUntil).toISOString().slice(0, 10) : null,
      }));

      return JSON.stringify({ totalMatched: total, shown: items.length, quotes: items });
    },
  });

  const queryClients = betaZodTool({
    name: "query_clients",
    description:
      "Search this company's clients. Returns name, status, and job count only — no contact email, phone, or address.",
    inputSchema: z.object({
      status: z.enum(["active", "inactive"]).optional(),
      search: z.string().optional().describe("Filter by client name containing this text."),
    }),
    run: async ({ status, search }) => {
      const match: Record<string, any> = { company: companyObjectId, isDeleted: false };
      if (status) match.status = status;
      if (search?.trim()) match.name = { $regex: search.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), $options: "i" };

      const [clients, total] = await Promise.all([
        Client.find(match).select("name status").sort({ name: 1 }).limit(RESULT_CAP).lean(),
        Client.countDocuments(match),
      ]);

      const clientIds = clients.map((c: any) => c._id);
      const jobCounts = await Job.aggregate([
        { $match: { company: companyId, isDeleted: false, client: { $in: clientIds } } },
        { $group: { _id: "$client", count: { $sum: 1 } } },
      ]);
      const countByClient = new Map(jobCounts.map((c: any) => [String(c._id), c.count]));

      const items = clients.map((c: any) => ({
        name: c.name,
        status: c.status,
        jobCount: countByClient.get(String(c._id)) ?? 0,
      }));

      return JSON.stringify({ totalMatched: total, shown: items.length, clients: items });
    },
  });

  const queryWorkers = betaZodTool({
    name: "query_workers",
    description:
      "Search this company's workers/staff. Returns name, role, and active status only — never email, phone, address, pay rate, bank details, or any identifying document numbers.",
    inputSchema: z.object({
      role: z.enum(["worker", "manager", "admin"]).optional(),
      isActive: z.boolean().optional(),
      search: z.string().optional().describe("Filter by name containing this text."),
    }),
    run: async ({ role, isActive, search }) => {
      const match: Record<string, any> = { company: companyId };
      if (role) match.role = role;
      if (isActive !== undefined) match.isActive = isActive;
      if (search?.trim()) match.fullname = { $regex: search.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), $options: "i" };

      const [workers, total] = await Promise.all([
        UserModel.find(match).select("fullname role isActive").sort({ fullname: 1 }).limit(RESULT_CAP).lean(),
        UserModel.countDocuments(match),
      ]);

      const items = workers.map((w: any) => ({
        name: w.fullname,
        role: w.role,
        active: w.isActive,
      }));

      return JSON.stringify({ totalMatched: total, shown: items.length, workers: items });
    },
  });

  const getCompanyOverview = betaZodTool({
    name: "get_company_overview",
    description:
      "High-level snapshot for this company: active worker count, jobs this week by status, invoice totals/outstanding balance, open quote count. Good first call for broad questions like \"how's the business doing\".",
    inputSchema: z.object({}),
    run: async () => {
      const now = new Date();
      const startOfWeek = new Date(now);
      startOfWeek.setDate(now.getDate() - now.getDay());
      startOfWeek.setHours(0, 0, 0, 0);
      const endOfWeek = new Date(startOfWeek);
      endOfWeek.setDate(startOfWeek.getDate() + 7);

      const [activeWorkers, jobsThisWeek, invoiceAgg, openQuotes] = await Promise.all([
        UserModel.countDocuments({ company: companyId, role: "worker", isActive: true }),
        Job.aggregate([
          { $match: { company: companyId, isDeleted: false, isTemplate: false, date: { $gte: startOfWeek, $lt: endOfWeek } } },
          { $group: { _id: "$status", count: { $sum: 1 } } },
        ]),
        Invoice.aggregate([
          { $match: { company: companyObjectId, isDeleted: false, status: { $ne: "cancelled" } } },
          {
            $group: {
              _id: null,
              totalInvoiced: { $sum: "$total" },
              outstandingBalance: {
                $sum: {
                  $cond: [{ $eq: ["$status", "sent"] }, { $max: [{ $subtract: ["$total", { $ifNull: ["$amountPaid", 0] }] }, 0] }, 0],
                },
              },
            },
          },
        ]),
        Quote.countDocuments({ company: companyObjectId, isDeleted: false, status: { $in: ["sent", "viewed"] } }),
      ]);

      const jobsByStatus: Record<string, number> = {};
      for (const row of jobsThisWeek as any[]) jobsByStatus[row._id ?? "unknown"] = row.count;

      return JSON.stringify({
        activeWorkers,
        jobsThisWeekByStatus: jobsByStatus,
        totalInvoiced: Number((invoiceAgg[0]?.totalInvoiced ?? 0).toFixed(2)),
        outstandingBalance: Number((invoiceAgg[0]?.outstandingBalance ?? 0).toFixed(2)),
        openQuotes,
      });
    },
  });

  return [queryJobs, queryInvoices, queryQuotes, queryClients, queryWorkers, getCompanyOverview];
}
