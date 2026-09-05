import mongoose, { InferSchemaType, Schema } from "mongoose";

/**
 * Everything a restricted user can be blocked from doing.
 *
 * Deliberately granular rather than a single on/off switch: a worker with an
 * expired badge shouldn't be able to accept new shifts, but must still be able
 * to clock out of the one they're standing on and see their own timesheet.
 */
export const RESTRICTABLE_ACTIONS = [
  "accept_jobs",
  "claim_jobs",
  "clock_in",
  "clock_out",
  "edit_profile",
  "view_timesheets",
  "view_earnings",
  "view_messages",
] as const;

export type RestrictableAction = (typeof RESTRICTABLE_ACTIONS)[number];

const UserRestrictionSchema = new Schema(
  {
    // ── Scoping ───────────────────────────────────────────────────────
    company: {
      type: Schema.Types.ObjectId,
      ref: "Company",
      required: true,
      index: true,
    },
    user: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },

    // ── Why ───────────────────────────────────────────────────────────
    reason: {
      type: String,
      enum: ["document_expired", "disciplinary", "no_show", "left_company", "other"],
      required: true,
    },

    /** Shown to the restricted user. Write it as if they'll read it — they will. */
    message: {
      type: String,
      required: true,
      trim: true,
      maxlength: 2000,
    },

    /** Managers only. Never returned to the restricted user. */
    internalNote: {
      type: String,
      trim: true,
      maxlength: 3000,
    },

    // ── What they can't do ────────────────────────────────────────────
    /**
     * `restrictions` is the single source of truth for what's blocked.
     *
     * `accessLevel` is a convenience label used only for presentation and for
     * the "none" shortcut — it must never contradict the array. Use the
     * `blocks()` method rather than reading either field directly, so the
     * precedence lives in one place.
     */
    accessLevel: {
      type: String,
      enum: ["none", "read_only", "limited"],
      default: "read_only",
      index: true,
    },

    restrictions: [
      {
        type: String,
        enum: RESTRICTABLE_ACTIONS,
      },
    ],

    // ── The way out ───────────────────────────────────────────────────
    /**
     * A restriction with no remedy is just a lock. Every one should carry
     * something the user can actually do about it — most often uploading a
     * replacement document, which lifts it without anyone picking up a phone.
     */
    remedy: {
      type: String,
      enum: ["upload_document", "contact_manager", "appeal", "none"],
      default: "contact_manager",
    },
    canAppeal: {
      type: Boolean,
      default: true,
    },

    // ── Lifecycle ─────────────────────────────────────────────────────
    status: {
      type: String,
      enum: ["active", "lifted", "expired"],
      default: "active",
      index: true,
    },

    startsAt: { type: Date, default: Date.now },

    /** Set for time-limited restrictions. Lifted lazily on read — see isExpired. */
    expiresAt: Date,

    restrictedBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    liftedAt: Date,
    liftedBy: { type: Schema.Types.ObjectId, ref: "User" },
    liftReason: { type: String, trim: true, maxlength: 1000 },

    // ── Appeal ────────────────────────────────────────────────────────
    appeal: {
      submittedAt: Date,
      message: { type: String, trim: true, maxlength: 3000 },
      status: {
        type: String,
        enum: ["pending", "accepted", "rejected"],
      },
      respondedAt: Date,
      respondedBy: { type: Schema.Types.ObjectId, ref: "User" },
      response: { type: String, trim: true, maxlength: 3000 },
    },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// ─────────────────────────────────────────────────────────────
// Indexes
// ─────────────────────────────────────────────────────────────

/**
 * A user can only have one active restriction at a time. Without this,
 * two active rows could exist and the middleware's findOne would pick an
 * arbitrary one — silently applying the wrong rules.
 */
UserRestrictionSchema.index(
  { user: 1 },
  { unique: true, partialFilterExpression: { status: "active" } }
);

// Company-scoped list, e.g. "all active restrictions"
UserRestrictionSchema.index({ company: 1, status: 1, createdAt: -1 });

// Appeals awaiting a manager's response
UserRestrictionSchema.index({ company: 1, "appeal.status": 1 });

// ─────────────────────────────────────────────────────────────
// Virtuals
// ─────────────────────────────────────────────────────────────

/**
 * Derived rather than stored, so it can't go stale between cron runs.
 * `status` still flips to "expired" lazily when the middleware sees this.
 */
UserRestrictionSchema.virtual("isExpired").get(function (this: any) {
  return Boolean(this.expiresAt && new Date(this.expiresAt) < new Date());
});

UserRestrictionSchema.virtual("isCurrentlyActive").get(function (this: any) {
  return this.status === "active" && !this.isExpired;
});

UserRestrictionSchema.virtual("hasPendingAppeal").get(function (this: any) {
  return this.appeal?.status === "pending";
});

// ─────────────────────────────────────────────────────────────
// Methods
// ─────────────────────────────────────────────────────────────

/**
 * The one place that decides whether an action is blocked, so the middleware
 * and the frontend can't drift apart on precedence.
 *
 *   none       → everything is blocked
 *   read_only  → all mutating actions blocked, viewing allowed
 *   limited    → only what's listed in `restrictions`
 */
const MUTATING_ACTIONS: RestrictableAction[] = [
  "accept_jobs",
  "claim_jobs",
  "clock_in",
  "clock_out",
  "edit_profile",
];

UserRestrictionSchema.methods.blocks = function (
  this: any,
  action: RestrictableAction
): boolean {
  if (!this.isCurrentlyActive) return false;
  if (this.accessLevel === "none") return true;
  if (this.accessLevel === "read_only") return MUTATING_ACTIONS.includes(action);
  return (this.restrictions ?? []).includes(action);
};

/** Safe to send to the restricted user — omits internalNote. */
UserRestrictionSchema.methods.toUserFacing = function (this: any) {
  return {
    _id: this._id,
    reason: this.reason,
    message: this.message,
    accessLevel: this.accessLevel,
    restrictions: this.restrictions ?? [],
    remedy: this.remedy,
    // Once an appeal is already in, there's nothing left to submit —
    // canAppeal here means "can submit one right now", not "was allowed to".
    canAppeal: this.canAppeal && !this.appeal?.submittedAt,
    startsAt: this.startsAt,
    expiresAt: this.expiresAt,
    liftedAt: this.liftedAt,
    liftReason: this.liftReason,
    appeal: this.appeal?.submittedAt
      ? {
          submittedAt: this.appeal.submittedAt,
          message: this.appeal.message,
          status: this.appeal.status,
          respondedAt: this.appeal.respondedAt,
          response: this.appeal.response,
        }
      : undefined,
  };
};

// ─────────────────────────────────────────────────────────────
// Validation
// ─────────────────────────────────────────────────────────────

UserRestrictionSchema.pre("validate", async function () {
  if (this.expiresAt && this.startsAt && this.expiresAt < this.startsAt) {
    throw new Error("Expiry cannot be before the start date");
  }

  // "limited" without a list of what's limited blocks nothing at all —
  // almost certainly a mistake rather than an intentional no-op
  if (this.accessLevel === "limited" && !this.restrictions?.length) {
    throw new Error(
      "A limited restriction needs at least one restricted action"
    );
  }

  if (this.status === "lifted" && !this.liftedAt) {
    this.liftedAt = new Date();
  }
});

/**
 * A worker mid-shift must always be able to clock out — blocking that loses
 * their hours and their pay. Enforced here so it can't be forgotten at a
 * call site.
 */
UserRestrictionSchema.pre("save", async function () {
  if (this.accessLevel === "none") return;
  if ((this.restrictions ?? []).includes("clock_out")) {
    const JobAssignment = mongoose.model("JobAssignment");
    const onShift = await JobAssignment.exists({
      worker: this.user,
      status: "in-progress",
    });
    if (onShift) {
      throw new Error(
        "This worker is mid-shift. Let them clock out before restricting clock-out."
      );
    }
  }
});

// ─────────────────────────────────────────────────────────────

export type UserRestriction = InferSchemaType<typeof UserRestrictionSchema>;

export default mongoose.model("UserRestriction", UserRestrictionSchema);