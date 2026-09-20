// models/apiKeyModel.ts
//
// Company-issued credentials for external integrations (a client's own
// booking website, etc.) — see routes/externalRouter.ts and
// middleware/apiKeyAuthMiddleware.ts. The raw key is only ever shown once,
// at creation time (apiKeyController.ts); only its hash is ever persisted,
// same principle as a password.
import mongoose, { InferSchemaType, Schema } from "mongoose";

const ApiKeySchema = new Schema(
  {
    company: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Company",
      required: true,
      index: true,
    },

    // A manager-chosen label ("Booking website", "Zapier") — purely for the
    // company's own bookkeeping in the settings UI.
    name: { type: String, required: true, trim: true },

    // SHA-256 of the raw key — the raw value is never stored anywhere.
    keyHash: { type: String, required: true, unique: true, index: true },

    // First few characters of the raw key ("ipk_live_a1b2"), kept only so
    // the settings UI can show "...a1b2" without ever holding the real key.
    keyPrefix: { type: String, required: true },

    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    lastUsedAt: { type: Date, default: null },

    isActive: { type: Boolean, default: true, index: true },
    revokedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

export type ApiKey = InferSchemaType<typeof ApiKeySchema>;
export default mongoose.model("ApiKey", ApiKeySchema);
