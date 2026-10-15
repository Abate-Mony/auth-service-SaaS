import mongoose, { InferSchemaType, Schema } from "mongoose";
import { IUser } from "../interfaces/models/user.js";
import { FileRefSchema } from "./shared/fileRefSchema.js";
export interface IUserModel extends mongoose.Document, IUser {
  getDefaultResultOrder(): void;
}


const UserSchema = new Schema(
  {
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },
    fullname: {
      type: String,
      required: true,
    },
    company: {
      type: Schema.Types.ObjectId,
      ref: "Company",
      required: function (this: any) {
        // Required for managers and workers.
        // Owners and admins might not have it strictly on step 1 of
        // registration (an owner IS the one creating the company), but it
        // should be attached immediately after the company is created.
        return this.role !== "admin" && this.role !== "owner";
      },
    },

    password: {
      type: String,
      required: true,
      select: false,
    },

    role: {
      type: String,
      enum: ["owner", "admin", "manager", "worker","client"],
      default: "worker",
    },

    // Only set when role === "client" — links a portal-login account back
    // to the business/customer record it manages. Multiple User docs with
    // role:"client" can share the same client (an owner/manager/booking/
    // billing/viewer team, not one shared login) — see clientRole below.
    // Enforced together with clientRole by the pre("validate") hook.
    client: {
      type: Schema.Types.ObjectId,
      ref: "Client",
      default: null,
    },

    // Portal-side permission level — distinct from `role`, which only ever
    // says "this is a client-portal account," not what it can do within
    // the portal. Capability enforcement per level is Milestone 2+; this
    // milestone only validates the value is one of these five.
    clientRole: {
      type: String,
      enum: ["owner", "manager", "booking", "billing", "viewer"],
      default: null,
    },
    platformRole: {
      type: String,
      enum: [
        "super_admin",
        "support_admin",
        "billing_admin"
      ],
      default: null,
    },
    phone: { type: String, trim: true, default: "0000-0000-0000" },
    gender: {
      type: String,
      enum: ["Male", "Female", "Other", "Prefer not to say"],
    },
    createdBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: function (this: any) { return this.role !== "admin" && this.role !== "owner" },
    },
    isVerified: {
      type: Boolean,
      default: false,
    },

    isActive: {
      type: Boolean,
      default: true,
    },

    // Set when a worker asks to have their account removed — see
    // requestAccountDeletion in workerController.ts. This app has no
    // in-app account creation (accounts are provisioned by a company
    // admin), so deletion is admin-mediated too: this just gives the
    // request a visible, timestamped record rather than only existing as
    // a one-off email. Cleared by nothing automatically — an admin
    // resolves it by actually deactivating/deleting the worker.
    deletionRequestedAt: {
      type: Date,
      default: null,
    },

    lastLogin: Date,

    // One entry per logged-in device/session — replaces the old single-slot
    // refreshToken/refreshTokenExpiresAt below, which could only ever hold
    // ONE session at a time (logging in anywhere else silently invalidated
    // every other device). issueTokens() pushes a new entry on login and
    // rotates (pull+push) the matching entry on refresh, capped at the 10
    // most recent sessions per user. See authControler.ts.
    sessions: {
      type: [
        {
          tokenHash: { type: String, required: true },
          expiresAt: { type: Date, required: true },
          createdAt: { type: Date, default: Date.now },
        },
      ],
      select: false,
      default: [],
    },

    // Deprecated — superseded by `sessions` above. Kept only so a refresh
    // token issued before this field existed still works, via refresh()'s
    // backward-compatible lookup, instead of being silently logged out by
    // this deploy. Safe to delete this field (and that lookup branch) once
    // REFRESH_TOKEN_EXPIRES_IN_DAYS has fully elapsed since this shipped.
    refreshToken: {
      type: String,
      select: false,
    },
    refreshTokenExpiresAt: {
      type: Date,
      select: false,
    },

    emailVerificationToken: {
      type: String,
      select: false,
    },
    emailVerificationExpiresAt: {
      type: Date,
      select: false,
    },

    passwordResetToken: {
      type: String,
      select: false,
    },
    passwordResetExpiresAt: {
      type: Date,
      select: false,
    },

    // One entry per subscribed device/browser — a worker can have several.
    pushSubscriptions: {
      type: [
        {
          endpoint: { type: String, required: true },
          keys: {
            p256dh: { type: String, required: true },
            auth: { type: String, required: true },
          },
        },
      ],
      default: [],
    },

    // Expo push tokens, one per mobile device the worker is logged in on.
    expoPushTokens: {
      type: [String],
      default: [],
    },

    // Any role can set their own — a personal account setting, not
    // restricted to workers.
    profilePhoto: { type: FileRefSchema, default: null },

    // Documents a worker uploads about themselves (ID, right-to-work,
    // certifications, etc.) — self-service, viewable by the worker and by
    // admins/managers in the same company. resourceType is Cloudinary's own
    // classification (image vs raw), stored at upload time so a later
    // delete uses the exact value Cloudinary expects instead of guessing.
    documents: {
      type: [
        {
          name: { type: String, required: true, trim: true },
          url: { type: String, required: true },
          publicId: { type: String, required: true },
          resourceType: { type: String, enum: ["image", "raw"], required: true },
          mimeType: { type: String },
          uploadedAt: { type: Date, default: Date.now },
        },
      ],
      default: [],
    },
  },
  {
    timestamps: true,
  }
);



UserSchema.methods.toJSON = function () {
  let obj = this.toObject();
  delete obj.password;
  return obj;
};

// A role:"client" account must be a complete portal identity — both
// `client` (who they represent) and `clientRole` (what they can do) — or
// Milestone 2's capability checks would have to special-case a half-set
// account. Any other role never carries these fields, so a role change
// away from "client" can't leave a stale client/clientRole behind.
UserSchema.pre("validate", function () {
  if (this.role === "client") {
    if (!this.client) {
      throw new Error("Client users must be linked to a client");
    }
    if (!this.clientRole) {
      throw new Error("Client users must have a client role");
    }
  } else {
    this.client = undefined;
    this.clientRole = undefined;
  }
});

// Supports refresh()'s session lookup by token hash — the old single-slot
// refreshToken field this replaces had no index at all (an unindexed
// collection scan on every refresh/logout), so this is a net improvement,
// not just carrying the gap forward into the new shape.
UserSchema.index({ "sessions.tokenHash": 1 });

export type User = InferSchemaType<typeof UserSchema>;
export default mongoose.model("User", UserSchema);
