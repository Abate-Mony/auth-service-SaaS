import mongoose, { InferSchemaType, Schema } from "mongoose";

// Internal support notes on a company ("Called 12 Nov about invoices").
// Platform staff only — never exposed to tenant routes.
const PlatformCompanyNoteSchema = new Schema(
  {
    company: { type: Schema.Types.ObjectId, ref: "Company", required: true, index: true },
    author: { type: Schema.Types.ObjectId, ref: "User", required: true },
    authorEmail: { type: String, required: true },
    body: { type: String, required: true, trim: true, maxlength: 4000 },
  },
  { timestamps: true }
);

PlatformCompanyNoteSchema.index({ company: 1, createdAt: -1 });

export type PlatformCompanyNote = InferSchemaType<typeof PlatformCompanyNoteSchema>;
export default mongoose.model("PlatformCompanyNote", PlatformCompanyNoteSchema);
