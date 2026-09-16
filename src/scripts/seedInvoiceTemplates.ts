// Seeds the 10 system invoice templates (isSystemPreset: true, company:
// null) — global, available to every company as choices for
// Company.defaultInvoiceTemplate or a one-off Invoice.template.
//
// Run with: node dist/scripts/seedInvoiceTemplates.js
// (build first with `npm run build`.)
//
// Idempotent: upserts by presetKey (the partial unique index on
// { presetKey: 1, isSystemPreset: true } is what makes this safe), so
// re-running after a wording/color tweak here updates the existing 10 in
// place rather than creating duplicates.
import * as dotenv from "dotenv";
dotenv.config({ path: "./.env" });
import mongoose from "mongoose";
import InvoiceTemplate from "../models/invoiceTemplateModel.js";

interface PresetDef {
  presetKey: string;
  name: string;
  baseLayout: "modern" | "classic" | "minimal";
  accentColor: string;
  font: "Helvetica" | "Times-Roman" | "Inter";
  logoPosition: "top-left" | "top-center" | "top-right";
}

// Three structural renderers (invoicePdf.ts), ten combinations — see the
// design brief this was built from: each baseLayout has a genuinely
// distinct structure (card-style vs a ruled table vs sparse single-line
// rows), and the color/font/logo knobs give each preset its own identity
// on top of that shared structure.
const PRESETS: PresetDef[] = [
  { presetKey: "modern-navy", name: "Modern Navy", baseLayout: "modern", accentColor: "#1E3A5F", font: "Inter", logoPosition: "top-left" },
  { presetKey: "modern-emerald", name: "Modern Emerald", baseLayout: "modern", accentColor: "#047857", font: "Inter", logoPosition: "top-left" },
  { presetKey: "modern-indigo", name: "Modern Indigo", baseLayout: "modern", accentColor: "#4338CA", font: "Helvetica", logoPosition: "top-right" },
  { presetKey: "modern-charcoal", name: "Modern Charcoal", baseLayout: "modern", accentColor: "#334155", font: "Inter", logoPosition: "top-center" },

  { presetKey: "classic-executive", name: "Classic Executive", baseLayout: "classic", accentColor: "#111827", font: "Times-Roman", logoPosition: "top-left" },
  { presetKey: "classic-burgundy", name: "Classic Burgundy", baseLayout: "classic", accentColor: "#7F1D1D", font: "Times-Roman", logoPosition: "top-left" },
  { presetKey: "classic-blue", name: "Classic Blue", baseLayout: "classic", accentColor: "#1D4ED8", font: "Times-Roman", logoPosition: "top-right" },

  { presetKey: "minimal-slate", name: "Minimal Slate", baseLayout: "minimal", accentColor: "#64748B", font: "Helvetica", logoPosition: "top-left" },
  { presetKey: "minimal-mono", name: "Minimal Mono", baseLayout: "minimal", accentColor: "#18181B", font: "Helvetica", logoPosition: "top-center" },
  { presetKey: "minimal-forest", name: "Minimal Forest", baseLayout: "minimal", accentColor: "#166534", font: "Inter", logoPosition: "top-left" },
];

async function main() {
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error("MONGO_URI is not set.");

  await mongoose.connect(uri);

  let created = 0;
  let updated = 0;

  for (const preset of PRESETS) {
    const result = await InvoiceTemplate.updateOne(
      { presetKey: preset.presetKey, isSystemPreset: true },
      {
        $set: {
          ...preset,
          isSystemPreset: true,
          company: null,
          createdBy: null,
          showVatBreakdown: true,
          showPaymentTerms: true,
          showNotes: true,
          isDeleted: false,
        },
      },
      { upsert: true }
    );

    if (result.upsertedCount > 0) {
      created++;
      console.log(`Created "${preset.name}" (${preset.presetKey})`);
    } else if (result.modifiedCount > 0) {
      updated++;
      console.log(`Updated "${preset.name}" (${preset.presetKey})`);
    } else {
      console.log(`"${preset.name}" (${preset.presetKey}) already up to date`);
    }
  }

  console.log("");
  console.log(`Seed complete — ${created} created, ${updated} updated, ${PRESETS.length - created - updated} unchanged.`);

  await mongoose.disconnect();
}

main().catch(err => {
  console.error("Seeding invoice templates failed:", err);
  process.exit(1);
});
