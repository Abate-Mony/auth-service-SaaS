import { Schema } from "mongoose";

// Shared shape for a single uploaded file reference (a job's attachment, a
// user's profile photo, a company's logo, ...). Deliberately a real
// sub-schema (not a plain nested-path object) with no required leaves — a
// plain nested object with `required: true` fields would fail Mongoose's
// "required" validation on every document that never set the field at all,
// since it validates nested-path leaves independently of whether the parent
// was ever assigned.
export const FileRefSchema = new Schema(
  {
    url: { type: String },
    publicId: { type: String },
    resourceType: { type: String, enum: ["image", "raw"] },
    filename: { type: String },
    mimeType: { type: String },
    uploadedAt: { type: Date, default: Date.now },
  },
  { _id: false }
);
