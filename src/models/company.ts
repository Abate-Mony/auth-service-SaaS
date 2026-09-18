import mongoose, { InferSchemaType, Schema } from "mongoose";
import { BUSINESS_TYPES, COMPANY_SIZES } from "../utils/constant.js";
import { ICompany } from "../interface/model/company.js";
import { FileRefSchema } from "./shared/fileRefSchema.js";

export interface ICompanyModel extends mongoose.Document, ICompany { }

const CompanySchema = new Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    businessType: {
      type: String,
      enum: BUSINESS_TYPES,
      required: true,
    },
    size: {
      type: String,
      enum: COMPANY_SIZES,
      required: true,
    },
    website: {
      type: String,
      trim: true,
    },
    phone: {
      type: String,
      trim: true,
    },
    country: {
      type: String,
      trim: true,
    },
    owner: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    logo: { type: FileRefSchema, default: null },
    plan: {
      type: String,
      enum: ["free", "starter", "professional", "enterprise"],
      default: "free",
      index: true,
    },
    // A per-company override, not the plan's own cap (that lives in
    // PLAN_LIMITS, keyed by `plan`) — most companies never set this, and
    // planLimits.ts's getEffectiveMaxWorkers() falls back to the plan's
    // default. Exists for negotiated Enterprise limits that don't match the
    // standard tier numbers.
    maxWorkers: {
      type: Number,
      default: null,
    },

    // ── Time & attendance ──────────────────────────────────────────────
    clockInGraceMinutes: { type: Number, default: 30 },
    lateThresholdMinutes: { type: Number, default: 10 },
    autoClockOutEnabled: { type: Boolean, default: true },
    // How many hours past a shift's scheduled end an "in-progress"
    // assignment with no clock-out is force-closed by the cron.
    autoClockOutAfterHours: { type: Number, default: 2 },
    // How many minutes past scheduled end a worker's own clock-out can run
    // before the extra time needs a manager's approval.
    lateClockOutThresholdMinutes: { type: Number, default: 15 },
    payFromScheduledStart: { type: Boolean, default: false },

    // ── Location ────────────────────────────────────────────────────────
    geofenceMode: { type: String, enum: ["off", "warn", "enforce"], default: "warn" },
    defaultGeofenceRadiusMeters: { type: Number, default: 150 },

    // ── Breaks ──────────────────────────────────────────────────────────
    breaksArePaid: { type: Boolean, default: false },
    autoDeductBreakMinutes: { type: Number, default: 0 }, // 0 = off
    autoDeductAfterMinutes: { type: Number, default: 360 },

    // ── Pay ─────────────────────────────────────────────────────────────
    overtimeThresholdMinutes: { type: Number, default: 480 },
    overtimeMultiplier: { type: Number, default: 1.5 },
    weeklyHoursTarget: { type: Number, default: 0 },
    currency: { type: String, enum: ["GBP", "USD", "EUR"], default: "GBP" },
    defaultPayRate: { type: Number, default: 0 },

    // ── Scheduling ──────────────────────────────────────────────────────
    timezone: { type: String, default: "Europe/London" },
    weekStartsOn: { type: String, enum: ["monday", "sunday"], default: "monday" },
    generateAheadDays: { type: Number, default: 30 },
    openShiftsEnabled: { type: Boolean, default: false },
    openShiftsRequireApproval: { type: Boolean, default: true },

    // ── Invoicing ───────────────────────────────────────────────────────
    // null = fall back to a hardcoded system default (a specific
    // InvoiceTemplate presetKey) rather than failing to render. Whatever
    // sets this must verify the target template is either isSystemPreset
    // or company-owned by this same company — never trust a bare id.
    defaultInvoiceTemplate: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "InvoiceTemplate",
      default: null,
    },

    // Independent choice from defaultInvoiceTemplate even though both
    // point into the same InvoiceTemplate pool — a company may want a
    // different one of those same presets/custom templates for quotes.
    defaultQuoteTemplate: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "InvoiceTemplate",
      default: null,
    },

    // Automatic "this invoice is overdue" nudges to the client — see
    // utils/sendPaymentReminders.ts. Defaults on (most companies want
    // this chased automatically) with an opt-out, same reasoning as
    // Quote.sendThankYouEmailOnAccept.
    paymentRemindersEnabled: {
      type: Boolean,
      default: true,
    },

    // ── Email & Sending ───────────────────────────────────────────────
    // Lets a company send INPRN transactional email ("New shift assigned",
    // "Quote from ...") from their own domain instead of INPRN's. See
    // utils/companyEmail.ts's resolveCompanySender — this object is never
    // trusted blind: custom sending only actually applies once
    // domainStatus is "verified" AND senderEmail's domain exactly matches
    // sendingDomain, checked server-side on every send, not just at
    // configuration time.
    emailSettings: {
      provider: {
        type: String,
        enum: ["inprn", "custom"],
        default: "inprn",
      },

      senderName: {
        type: String,
        trim: true,
        default: "",
      },

      senderEmail: {
        type: String,
        trim: true,
        lowercase: true,
        default: "",
      },

      replyToEmail: {
        type: String,
        trim: true,
        lowercase: true,
        default: "",
      },

      // The subdomain a company connects (e.g. "mail.northstar.co.uk"),
      // not the sender address itself — see the domain-vs-sender-email
      // split in companyEmailController.ts.
      sendingDomain: {
        type: String,
        trim: true,
        lowercase: true,
        default: "",
      },

      // Resend's own domain id — never returned to the frontend. Guarded at
      // the serialization boundary (companyEmailController.ts's
      // serializeEmailSettings allowlist) rather than with select:false
      // here: this is a nested plain-object path, not its own sub-schema,
      // and composing select:false on a dotted nested path alongside a
      // parent-level select string is exactly the kind of Mongoose
      // selection-string fragility worth avoiding for a field that isn't a
      // credential (just an opaque provider id) in the first place.
      resendDomainId: {
        type: String,
        default: "",
      },

      domainStatus: {
        type: String,
        enum: ["not_connected", "pending", "verified", "failed"],
        default: "not_connected",
      },

      verifiedAt: {
        type: Date,
        default: null,
      },

      lastVerificationCheckAt: {
        type: Date,
        default: null,
      },
    },
  },
  {
    timestamps: true,
  }
);

export type Company = InferSchemaType<typeof CompanySchema>;
export default mongoose.model("Company", CompanySchema);