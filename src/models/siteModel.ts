import mongoose, { InferSchemaType, Schema } from "mongoose";

// A reusable physical workplace belonging to a Client — Company -> Client ->
// Site -> Job. Deliberately mirrors clientModel.ts's shape (same address
// sub-object, same status/isDeleted pair) rather than inventing a second
// convention. Geofence fields match Job's own (geofenceRadiusMeters +
// geofenceMode enum), not a separate {enabled,radiusM} shape, since Job
// snapshots a Site's geofence directly into those same fields at scheduling
// time (see jobController.ts's resolveJobSite/buildSiteSnapshot).
const SiteSchema = new Schema(
  {
    // ── Scoping ───────────────────────────────────────────────────────
    company: {
      type: Schema.Types.ObjectId,
      ref: "Company",
      required: true,
      index: true,
    },
    client: {
      type: Schema.Types.ObjectId,
      ref: "Client",
      required: true,
      index: true,
    },

    // ── Identity ──────────────────────────────────────────────────────
    name: {
      type: String,
      required: [true, "Site name is required"],
      trim: true,
      maxlength: 150,
    },

    // Same shape as Client.address — a Site's address is where the work
    // actually happens, distinct from the Client's own billing address.
    address: {
      line1: { type: String, trim: true },
      line2: { type: String, trim: true },
      city: { type: String, trim: true },
      county: { type: String, trim: true },
      postcode: { type: String, trim: true, uppercase: true },
      country: { type: String, trim: true, default: "United Kingdom" },
    },

    coordinates: {
      lat: Number,
      lng: Number,
    },

    // null = inherit the company default, same convention as Job's own
    // geofenceMode/geofenceRadiusMeters. A Job created from this Site
    // snapshots whichever value actually applied at scheduling time.
    geofenceMode: {
      type: String,
      enum: ["off", "warn", "enforce", null],
      default: null,
    },
    geofenceRadiusMeters: { type: Number, default: null },

    contact: {
      name: { type: String, trim: true, default: "" },
      phone: { type: String, trim: true, default: "" },
      email: { type: String, trim: true, lowercase: true, default: "" },
    },

    // Free text shown to assigned workers via the job they're scheduled to.
    instructions: { type: String, trim: true, default: "", maxlength: 2000 },
    accessInstructions: { type: String, trim: true, default: "", maxlength: 1000 },
    parkingInstructions: { type: String, trim: true, default: "", maxlength: 1000 },

    // ── State ─────────────────────────────────────────────────────────
    status: {
      type: String,
      enum: ["active", "inactive"],
      default: "active",
      index: true,
    },
    isDeleted: { type: Boolean, default: false, index: true },

    createdBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
  },
  { timestamps: true }
);

// Primary list query shape (all sites / a client's sites / active-only)
SiteSchema.index({ company: 1, client: 1 });
SiteSchema.index({ company: 1, status: 1, isDeleted: 1 });

// Site names only need to be unique within one client, not company-wide —
// two different clients can each have a "Reception" site. Partial so a
// soft-deleted site doesn't block reusing the name.
SiteSchema.index(
  { company: 1, client: 1, name: 1 },
  { unique: true, partialFilterExpression: { isDeleted: false } }
);

SiteSchema.virtual("formattedAddress").get(function (this: any) {
  const a = this.address ?? {};
  return [a.line1, a.line2, a.city, a.county, a.postcode, a.country]
    .filter(Boolean)
    .join(", ");
});

SiteSchema.set("toJSON", { virtuals: true });
SiteSchema.set("toObject", { virtuals: true });

export type Site = InferSchemaType<typeof SiteSchema>;
export default mongoose.model("Site", SiteSchema);
