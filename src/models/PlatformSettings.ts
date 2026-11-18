import mongoose, { InferSchemaType, Schema } from "mongoose";

// Singleton document (key: "global") for platform-wide settings that don't
// belong to any one company — currently just the maintenance-mode kill
// switch, but the `key` field leaves room for more without a schema change.
// Read on every tenant request by maintenanceModeMiddleware.ts, so this is
// deliberately a cheap, flat shape — no populate, no nested refs beyond
// `enabledBy`.
const PlatformSettingsSchema = new Schema(
  {
    key: { type: String, required: true, unique: true, default: "global" },
    maintenanceMode: {
      enabled: { type: Boolean, default: false },
      message: { type: String, default: null },
      enabledAt: { type: Date, default: null },
      enabledBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    },
  },
  { timestamps: true }
);

export type PlatformSettings = InferSchemaType<typeof PlatformSettingsSchema>;
export default mongoose.model("PlatformSettings", PlatformSettingsSchema);
