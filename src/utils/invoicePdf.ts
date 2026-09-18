import PDFDocument from "pdfkit";
import dayjs from "dayjs";

export interface InvoicePdfLineItem {
  description: string;
  type: "hourly" | "fixed" | "adjustment";
  date?: Date | string | null;
  startTime?: string | null;
  endTime?: string | null;
  location?: string | null;
  workerName?: string | null;
  hours: number;
  rate: number;
  amount: number;
}

// Matches InvoiceTemplate's flat fields (see models/invoiceTemplateModel.ts)
// — deliberately not importing the Mongoose type here, this file has no
// dependency on the DB layer, just the resolved values.
export interface InvoicePdfTemplate {
  baseLayout: "modern" | "classic" | "minimal";
  accentColor: string;
  font: "Helvetica" | "Times-Roman" | "Inter";
  logoPosition: "top-left" | "top-center" | "top-right";
  showVatBreakdown: boolean;
  showPaymentTerms: boolean;
  showNotes: boolean;
}

export const DEFAULT_INVOICE_TEMPLATE: InvoicePdfTemplate = {
  baseLayout: "modern",
  accentColor: "#1E3A5F",
  font: "Helvetica",
  logoPosition: "top-left",
  showVatBreakdown: true,
  showPaymentTerms: true,
  showNotes: true,
};

interface GenerateInvoicePdfOptions {
  invoiceNumber: string;

  companyName: string;
  companyAddress?: string;
  companyPhone?: string;

  clientName: string;
  clientAddress?: string;
  clientVatNumber?: string;

  issueDate: Date | string;
  dueDate: Date | string;
  servicePeriod?: { start?: Date | string | null; end?: Date | string | null } | null;

  lineItems: InvoicePdfLineItem[];

  subtotal: number;
  vatRate: number;
  vatAmount: number;
  total: number;

  currency: string;
  purchaseOrderNumber?: string;
  notes?: string;

  // Pre-fetched by the caller (buildInvoicePdfDocument) via
  // fetchImageBuffer — this file never does I/O itself. null/undefined
  // when the company has no logo, or fetching it failed; either way the
  // invoice still renders, just without one.
  logoBuffer?: Buffer | null;

  // Falls back to DEFAULT_INVOICE_TEMPLATE (the original single layout this
  // file used to always render) when omitted, so existing callers that
  // don't pass one keep working unchanged.
  template?: InvoicePdfTemplate;
}

const fmtMoney = (amount: number, currency: string) => {
  const symbol = currency === "USD" ? "$" : currency === "EUR" ? "€" : "£";
  const sign = amount < 0 ? "-" : "";
  return `${sign}${symbol}${Math.abs(amount).toFixed(2)}`;
};

const LEFT = 40;
const COLOR_HEADING = "#0F172A";
const COLOR_LABEL = "#64748B";
const COLOR_BODY = "#334155";
const COLOR_MUTED = "#94A3B8";
const COLOR_RULE = "#E2E8F0";

// pdfkit ships Helvetica/Times-Roman/Courier (plus bold/italic variants) as
// built-in fonts with no file to embed. "Inter" has no bundled .ttf in this
// project yet — registering one is a real follow-up, not done here — so it
// resolves to Helvetica for now rather than throwing at render time. The
// template's own `font` value is left as "Inter" in storage/API responses;
// only the actual pdfkit draw calls get the substitution.
const resolveFont = (font: InvoicePdfTemplate["font"], bold: boolean): string => {
  if (font === "Times-Roman") return bold ? "Times-Bold" : "Times-Roman";
  // "Helvetica" and the "Inter" fallback both land here.
  return bold ? "Helvetica-Bold" : "Helvetica";
};

// "Real" work: hourly/fixed lines with a snapshot date — everything that
// existed before this line-item shape was introduced (or a generic manual
// item) has no date and renders as a plain legacy charge instead, rather
// than crashing on missing job/shift metadata.
const isShiftItem = (item: InvoicePdfLineItem) => item.type !== "adjustment" && !!item.date;
const isLegacyItem = (item: InvoicePdfLineItem) => item.type !== "adjustment" && !item.date;

type Ctx = GenerateInvoicePdfOptions & { template: InvoicePdfTemplate };

// ─────────────────────────────────────────────────────────────
// Shared helpers — the pieces that don't structurally differ between
// layouts, only in color/font/alignment. Each takes the current pdfkit
// cursor position implicitly (doc.y) and leaves doc.y at the bottom of
// what it drew.
// ─────────────────────────────────────────────────────────────

function ensureSpace(doc: PDFKit.PDFDocument, needed: number) {
  if (doc.y + needed > doc.page.height - 100) {
    doc.addPage({ size: "A4", margin: 40 });
    doc.y = 40;
  }
}

// X position for both the heading text block AND the logo image (see
// renderLogo below) — left/center/right per template.logoPosition, so
// whichever one is present always lands on the same edge.
function headerColumnX(logoPosition: InvoicePdfTemplate["logoPosition"], pageWidth: number, blockWidth: number): number {
  if (logoPosition === "top-center") return LEFT + (pageWidth - blockWidth) / 2;
  if (logoPosition === "top-right") return LEFT + pageWidth - blockWidth;
  return LEFT;
}

// Drawn within the same 220-wide slot headingX already reserves for the
// heading text below it, so the logo and "INVOICE"/number stay aligned to
// whichever edge logoPosition picked instead of each computing its own,
// possibly different, anchor. Wrapped in try/catch — pdfkit throws
// synchronously on an unsupported format (e.g. an SVG logo, which pdfkit
// can't rasterize), and that must never take the whole PDF down with it.
const LOGO_BOX_HEIGHT = 32;
// pdfkit's image `align` only accepts "center"/"right" (left is the
// implicit default, omitting the option entirely) — not a 3-way enum.
const LOGO_ALIGN: Record<InvoicePdfTemplate["logoPosition"], "center" | "right" | undefined> = {
  "top-left": undefined,
  "top-center": "center",
  "top-right": "right",
};

function renderLogo(doc: PDFKit.PDFDocument, ctx: Ctx, headingX: number): void {
  if (!ctx.logoBuffer) return;
  try {
    doc.image(ctx.logoBuffer, headingX, doc.y, {
      fit: [220, LOGO_BOX_HEIGHT],
      align: LOGO_ALIGN[ctx.template.logoPosition],
    });
  } catch (err) {
    console.error("renderLogo failed:", err);
    return;
  }
  doc.y += LOGO_BOX_HEIGHT + 8;
}

function renderPartyBlocks(doc: PDFKit.PDFDocument, ctx: Ctx, pageWidth: number, opts: { labelColor: string; accentLabels: boolean }) {
  const { template } = ctx;
  const fontReg = resolveFont(template.font, false);
  const fontBold = resolveFont(template.font, true);
  const rightColX = LEFT + pageWidth / 2 + 10;
  const colWidth = pageWidth / 2 - 15;
  const blockY = doc.y;
  const labelColor = opts.accentLabels ? template.accentColor : opts.labelColor;

  doc.font(fontBold).fontSize(8).fillColor(labelColor).text("BILL TO", LEFT, blockY);
  doc.font(fontBold).fontSize(12).fillColor(COLOR_HEADING).text(ctx.clientName, LEFT, blockY + 14, { width: colWidth });
  let billToY = doc.y + 2;
  if (ctx.clientAddress) {
    doc.font(fontReg).fontSize(9).fillColor(COLOR_LABEL).text(ctx.clientAddress, LEFT, billToY, { width: colWidth });
    billToY = doc.y + 2;
  }
  if (ctx.clientVatNumber) {
    doc.font(fontReg).fontSize(9).fillColor(COLOR_LABEL).text(`VAT ${ctx.clientVatNumber}`, LEFT, billToY, { width: colWidth });
    billToY = doc.y + 2;
  }

  doc.font(fontBold).fontSize(8).fillColor(labelColor).text("FROM", rightColX, blockY);
  doc.font(fontBold).fontSize(12).fillColor(COLOR_HEADING).text(ctx.companyName, rightColX, blockY + 14, { width: colWidth });
  let fromY = doc.y + 2;
  if (ctx.companyAddress) {
    doc.font(fontReg).fontSize(9).fillColor(COLOR_LABEL).text(ctx.companyAddress, rightColX, fromY, { width: colWidth });
    fromY = doc.y + 2;
  }
  if (ctx.companyPhone) {
    doc.font(fontReg).fontSize(9).fillColor(COLOR_LABEL).text(ctx.companyPhone, rightColX, fromY, { width: colWidth });
    fromY = doc.y + 2;
  }

  doc.y = Math.max(billToY, fromY) + 10;
}

function renderServiceMeta(doc: PDFKit.PDFDocument, ctx: Ctx, pageWidth: number, labelColor: string) {
  const fontReg = resolveFont(ctx.template.font, false);
  const fontBold = resolveFont(ctx.template.font, true);

  if (ctx.servicePeriod?.start && ctx.servicePeriod?.end) {
    doc.font(fontBold).fontSize(8).fillColor(labelColor).text("SERVICE PERIOD", LEFT, doc.y);
    doc.font(fontReg).fontSize(10).fillColor(COLOR_BODY).text(
      `${dayjs(ctx.servicePeriod.start).format("D MMM YYYY")} – ${dayjs(ctx.servicePeriod.end).format("D MMM YYYY")}`,
      LEFT,
      doc.y + 2
    );
    doc.moveDown(0.8);
  }

  if (ctx.purchaseOrderNumber) {
    doc.font(fontReg).fontSize(9).fillColor(labelColor).text(`PO / Reference: ${ctx.purchaseOrderNumber}`, LEFT, doc.y);
    doc.moveDown(0.5);
  }
}

function renderPaymentAndNotes(doc: PDFKit.PDFDocument, ctx: Ctx, pageWidth: number, labelColor: string) {
  const fontReg = resolveFont(ctx.template.font, false);
  const fontBold = resolveFont(ctx.template.font, true);

  if (ctx.template.showPaymentTerms) {
    ensureSpace(doc, 60);
    doc.y += 14;
    doc.font(fontBold).fontSize(9).fillColor(labelColor).text("PAYMENT DETAILS", LEFT, doc.y);
    doc.y += 14;
    doc.font(fontReg).fontSize(9).fillColor(COLOR_BODY).text(`Payment due by ${dayjs(ctx.dueDate).format("D MMMM YYYY")}`, LEFT, doc.y);
    doc.y += 13;
    doc.font(fontReg).fontSize(9).fillColor(COLOR_BODY).text(`Reference: ${ctx.invoiceNumber}`, LEFT, doc.y);
    doc.y += 13;
  }

  if (ctx.template.showNotes && ctx.notes) {
    doc.y += 10;
    doc.font(fontBold).fontSize(9).fillColor(labelColor).text("NOTES", LEFT, doc.y);
    doc.y += 14;
    doc.font(fontReg).fontSize(9).fillColor(COLOR_BODY).text(ctx.notes, LEFT, doc.y, { width: pageWidth });
  }
}

function renderFooter(doc: PDFKit.PDFDocument, ctx: Ctx) {
  const fontReg = resolveFont(ctx.template.font, false);
  doc.font(fontReg).fontSize(8).fillColor(COLOR_MUTED).text(`Generated ${dayjs().format("D MMM YYYY HH:mm")} by ${ctx.companyName}`, LEFT, doc.page.height - 40, { align: "left" });
}

// ─────────────────────────────────────────────────────────────
// Modern — accent-forward, card-style line items, prominent brand color.
// ─────────────────────────────────────────────────────────────

function renderModernInvoice(doc: PDFKit.PDFDocument, ctx: Ctx, pageWidth: number) {
  const { template } = ctx;
  const fontReg = resolveFont(template.font, false);
  const fontBold = resolveFont(template.font, true);
  const rightColX = LEFT + pageWidth / 2 + 10;

  // Header
  const headingX = headerColumnX(template.logoPosition, pageWidth, 220);
  renderLogo(doc, ctx, headingX);
  doc.font(fontBold).fontSize(22).fillColor(template.accentColor).text("INVOICE", headingX, doc.y, { continued: false });
  doc.font(fontBold).fontSize(11).fillColor(COLOR_LABEL).text(ctx.invoiceNumber, headingX, doc.y);

  const dateBlockY = 40;
  doc.font(fontBold).fontSize(8).fillColor(COLOR_LABEL).text("ISSUED", rightColX, dateBlockY, { width: pageWidth / 2 - 10, align: "right" });
  doc.font(fontBold).fontSize(11).fillColor(COLOR_HEADING).text(dayjs(ctx.issueDate).format("D MMMM YYYY"), rightColX, dateBlockY + 12, { width: pageWidth / 2 - 10, align: "right" });
  doc.font(fontBold).fontSize(8).fillColor(COLOR_LABEL).text("DUE", rightColX, dateBlockY + 34, { width: pageWidth / 2 - 10, align: "right" });
  doc.font(fontBold).fontSize(11).fillColor(COLOR_HEADING).text(dayjs(ctx.dueDate).format("D MMMM YYYY"), rightColX, dateBlockY + 46, { width: pageWidth / 2 - 10, align: "right" });

  doc.y = Math.max(doc.y, dateBlockY + 70);
  doc.rect(LEFT, doc.y, pageWidth, 3).fill(template.accentColor);
  doc.y += 3;
  doc.moveDown(1.2);

  renderPartyBlocks(doc, ctx, pageWidth, { labelColor: COLOR_LABEL, accentLabels: true });
  renderServiceMeta(doc, ctx, pageWidth, COLOR_LABEL);

  doc.moveTo(LEFT, doc.y + 4).lineTo(LEFT + pageWidth, doc.y + 4).strokeColor(COLOR_RULE).stroke();
  doc.y += 16;

  // Line items — card style
  const shiftItems = ctx.lineItems.filter(isShiftItem);
  const legacyItems = ctx.lineItems.filter(isLegacyItem);
  const adjustmentItems = ctx.lineItems.filter(item => item.type === "adjustment");

  if (shiftItems.length || adjustmentItems.length) {
    doc.font(fontBold).fontSize(9).fillColor(template.accentColor).text("WORK COMPLETED", LEFT, doc.y);
    doc.y += 16;

    for (const item of shiftItems) {
      ensureSpace(doc, 50);
      const rowY = doc.y;

      doc.font(fontBold).fontSize(11).fillColor(COLOR_HEADING).text(item.description, LEFT, rowY, { width: pageWidth - 100 });
      doc.font(fontBold).fontSize(11).fillColor(COLOR_HEADING).text(fmtMoney(item.amount, ctx.currency), LEFT + pageWidth - 100, rowY, { width: 100, align: "right" });

      let y = rowY + 15;
      const detailParts = [item.date ? dayjs(item.date).format("D MMMM YYYY") : null, item.location].filter(Boolean);
      if (detailParts.length) {
        doc.font(fontReg).fontSize(9).fillColor(COLOR_LABEL).text(detailParts.join(" · "), LEFT, y, { width: pageWidth - 100 });
        y += 13;
      }

      // Hours shown here are derived from the actual charged amount, not
      // the raw stored quantity — see the original file's note: it's
      // independently rounded elsewhere and can be a penny off multiplied
      // back out, so deriving from amount/rate keeps this line consistent
      // with the amount printed next to it.
      const displayHours = item.type === "hourly" && item.rate > 0 ? Math.round((item.amount / item.rate) * 100) / 100 : item.hours;
      const billingLine =
        item.type === "hourly"
          ? `${item.startTime && item.endTime ? `${item.startTime}–${item.endTime} · ` : ""}${displayHours}h × ${fmtMoney(item.rate, ctx.currency)}/hour`
          : "Fixed job charge";
      doc.font(fontReg).fontSize(9).fillColor(COLOR_BODY).text(billingLine, LEFT, y, { width: pageWidth - 100 });
      y += 13;

      doc.y = y + 8;
      doc.moveTo(LEFT, doc.y).lineTo(LEFT + pageWidth, doc.y).strokeColor("#F1F5F9").stroke();
      doc.y += 10;
    }

    for (const item of adjustmentItems) {
      ensureSpace(doc, 35);
      const rowY = doc.y;
      doc.font(fontBold).fontSize(8).fillColor(COLOR_MUTED).text("ADJUSTMENT", LEFT, rowY);
      doc.font(fontReg).fontSize(11).fillColor(COLOR_HEADING).text(item.description, LEFT, rowY + 12, { width: pageWidth - 100 });
      doc.font(fontBold).fontSize(11).fillColor(item.amount < 0 ? "#DC2626" : COLOR_HEADING).text(fmtMoney(item.amount, ctx.currency), LEFT + pageWidth - 100, rowY + 12, { width: 100, align: "right" });
      doc.y = rowY + 30;
      doc.moveTo(LEFT, doc.y).lineTo(LEFT + pageWidth, doc.y).strokeColor("#F1F5F9").stroke();
      doc.y += 10;
    }
  }

  if (legacyItems.length) {
    ensureSpace(doc, 20);
    doc.font(fontBold).fontSize(9).fillColor(template.accentColor).text("OTHER CHARGES", LEFT, doc.y);
    doc.y += 16;

    for (const item of legacyItems) {
      ensureSpace(doc, 30);
      const rowY = doc.y;
      doc.font(fontReg).fontSize(10).fillColor(COLOR_BODY).text(item.description, LEFT, rowY, { width: pageWidth - 180 });
      if (item.hours) {
        doc.font(fontReg).fontSize(9).fillColor(COLOR_LABEL).text(`${item.hours}h × ${fmtMoney(item.rate, ctx.currency)}/hr`, LEFT, rowY + 13);
      }
      doc.font(fontBold).fontSize(10).fillColor(COLOR_HEADING).text(fmtMoney(item.amount, ctx.currency), LEFT + pageWidth - 100, rowY, { width: 100, align: "right" });
      doc.y = rowY + (item.hours ? 28 : 18);
      doc.moveTo(LEFT, doc.y).lineTo(LEFT + pageWidth, doc.y).strokeColor("#F1F5F9").stroke();
      doc.y += 10;
    }
  }

  // Totals — filled accent box around the final total
  ensureSpace(doc, 90);
  doc.y += 8;
  const summaryX = LEFT + pageWidth - 220;

  const summaryRow = (label: string, value: string) => {
    doc.font(fontReg).fontSize(10).fillColor(COLOR_LABEL).text(label, summaryX, doc.y, { width: 120 });
    doc.font(fontReg).fontSize(10).fillColor(COLOR_HEADING).text(value, summaryX + 100, doc.y - 12, { width: 100, align: "right" });
    doc.y += 16;
  };

  summaryRow("Subtotal", fmtMoney(ctx.subtotal, ctx.currency));
  if (template.showVatBreakdown && ctx.vatRate > 0) {
    summaryRow(`VAT (${ctx.vatRate}%)`, fmtMoney(ctx.vatAmount, ctx.currency));
  }

  doc.y += 4;
  doc.rect(summaryX - 12, doc.y, 220, 32).fill(`${template.accentColor}15`);
  doc.font(fontBold).fontSize(13).fillColor(template.accentColor).text("Total", summaryX, doc.y + 9, { width: 120 });
  doc.font(fontBold).fontSize(13).fillColor(template.accentColor).text(fmtMoney(ctx.total, ctx.currency), summaryX + 100, doc.y + 9, { width: 108, align: "right" });
  doc.y += 40;

  renderPaymentAndNotes(doc, ctx, pageWidth, template.accentColor);
  renderFooter(doc, ctx);
}

// ─────────────────────────────────────────────────────────────
// Classic — restrained branding, serif-friendly, a genuine ruled table
// for line items rather than cards.
// ─────────────────────────────────────────────────────────────

function renderClassicInvoice(doc: PDFKit.PDFDocument, ctx: Ctx, pageWidth: number) {
  const { template } = ctx;
  const fontReg = resolveFont(template.font, false);
  const fontBold = resolveFont(template.font, true);
  const rightColX = LEFT + pageWidth / 2 + 10;

  // Header — plain heading, accent used only as a thin rule, not on text.
  const headingX = headerColumnX(template.logoPosition, pageWidth, 220);
  renderLogo(doc, ctx, headingX);
  doc.font(fontBold).fontSize(20).fillColor(COLOR_HEADING).text("INVOICE", headingX, doc.y);
  doc.font(fontReg).fontSize(10).fillColor(COLOR_LABEL).text(ctx.invoiceNumber, headingX, doc.y);

  const dateBlockY = 40;
  doc.font(fontBold).fontSize(8).fillColor(COLOR_LABEL).text("ISSUED", rightColX, dateBlockY, { width: pageWidth / 2 - 10, align: "right" });
  doc.font(fontReg).fontSize(11).fillColor(COLOR_HEADING).text(dayjs(ctx.issueDate).format("D MMMM YYYY"), rightColX, dateBlockY + 12, { width: pageWidth / 2 - 10, align: "right" });
  doc.font(fontBold).fontSize(8).fillColor(COLOR_LABEL).text("DUE", rightColX, dateBlockY + 34, { width: pageWidth / 2 - 10, align: "right" });
  doc.font(fontReg).fontSize(11).fillColor(COLOR_HEADING).text(dayjs(ctx.dueDate).format("D MMMM YYYY"), rightColX, dateBlockY + 46, { width: pageWidth / 2 - 10, align: "right" });

  doc.y = Math.max(doc.y, dateBlockY + 70);
  doc.moveTo(LEFT, doc.y).lineTo(LEFT + pageWidth, doc.y).strokeColor(template.accentColor).lineWidth(1.5).stroke();
  doc.lineWidth(1);
  doc.moveDown(1.2);

  renderPartyBlocks(doc, ctx, pageWidth, { labelColor: COLOR_LABEL, accentLabels: false });
  renderServiceMeta(doc, ctx, pageWidth, COLOR_LABEL);

  doc.moveTo(LEFT, doc.y + 4).lineTo(LEFT + pageWidth, doc.y + 4).strokeColor(COLOR_RULE).stroke();
  doc.y += 16;

  // Line items — a real ruled table, unlike modern's cards.
  const allBillable = [...ctx.lineItems.filter(isShiftItem), ...ctx.lineItems.filter(isLegacyItem), ...ctx.lineItems.filter(item => item.type === "adjustment")];

  const colDesc = LEFT;
  const colDescW = pageWidth - 260;
  const colQty = LEFT + colDescW;
  const colQtyW = 90;
  const colRate = colQty + colQtyW;
  const colRateW = 80;
  const colAmount = colRate + colRateW;
  const colAmountW = pageWidth - (colDesc - LEFT) - colDescW - colQtyW - colRateW;

  if (allBillable.length) {
    ensureSpace(doc, 30);
    const headerY = doc.y;
    doc.font(fontBold).fontSize(8).fillColor(COLOR_LABEL).text("DESCRIPTION", colDesc, headerY, { width: colDescW });
    doc.font(fontBold).fontSize(8).fillColor(COLOR_LABEL).text("QTY", colQty, headerY, { width: colQtyW, align: "right" });
    doc.font(fontBold).fontSize(8).fillColor(COLOR_LABEL).text("RATE", colRate, headerY, { width: colRateW, align: "right" });
    doc.font(fontBold).fontSize(8).fillColor(COLOR_LABEL).text("AMOUNT", colAmount, headerY, { width: colAmountW, align: "right" });
    doc.y = headerY + 14;
    doc.moveTo(LEFT, doc.y).lineTo(LEFT + pageWidth, doc.y).strokeColor(COLOR_HEADING).stroke();
    doc.y += 8;

    for (const item of allBillable) {
      ensureSpace(doc, 34);
      const rowY = doc.y;
      const isAdjustment = item.type === "adjustment";
      const displayHours = item.type === "hourly" && item.rate > 0 ? Math.round((item.amount / item.rate) * 100) / 100 : item.hours;
      const qtyLabel = isAdjustment ? "—" : item.type === "fixed" ? "1" : `${displayHours}h`;
      const rateLabel = isAdjustment ? "—" : fmtMoney(item.rate, ctx.currency);

      doc.font(fontReg).fontSize(10).fillColor(COLOR_HEADING).text(item.description, colDesc, rowY, { width: colDescW });
      const detail = [item.date ? dayjs(item.date).format("D MMM YYYY") : null, item.location].filter(Boolean).join(" · ");
      let descBottom = doc.y;
      if (detail) {
        doc.font(fontReg).fontSize(8).fillColor(COLOR_MUTED).text(detail, colDesc, doc.y, { width: colDescW });
        descBottom = doc.y;
      }

      doc.font(fontReg).fontSize(10).fillColor(COLOR_BODY).text(qtyLabel, colQty, rowY, { width: colQtyW, align: "right" });
      doc.font(fontReg).fontSize(10).fillColor(COLOR_BODY).text(rateLabel, colRate, rowY, { width: colRateW, align: "right" });
      doc.font(fontBold).fontSize(10).fillColor(item.amount < 0 ? "#DC2626" : COLOR_HEADING).text(fmtMoney(item.amount, ctx.currency), colAmount, rowY, { width: colAmountW, align: "right" });

      doc.y = Math.max(descBottom, rowY + 14) + 8;
      doc.moveTo(LEFT, doc.y).lineTo(LEFT + pageWidth, doc.y).strokeColor(COLOR_RULE).stroke();
      doc.y += 10;
    }
  }

  // Totals — traditional double-rule close, no color fill.
  ensureSpace(doc, 90);
  doc.y += 8;
  const summaryX = LEFT + pageWidth - 220;

  const summaryRow = (label: string, value: string, bold = false) => {
    doc.font(bold ? fontBold : fontReg).fontSize(bold ? 12 : 10).fillColor(bold ? COLOR_HEADING : COLOR_LABEL).text(label, summaryX, doc.y, { width: 120 });
    doc.font(bold ? fontBold : fontReg).fontSize(bold ? 12 : 10).fillColor(COLOR_HEADING).text(value, summaryX + 100, doc.y - (bold ? 14 : 12), { width: 100, align: "right" });
    doc.y += bold ? 22 : 16;
  };

  summaryRow("Subtotal", fmtMoney(ctx.subtotal, ctx.currency));
  if (template.showVatBreakdown && ctx.vatRate > 0) {
    summaryRow(`VAT (${ctx.vatRate}%)`, fmtMoney(ctx.vatAmount, ctx.currency));
  }
  doc.moveTo(summaryX, doc.y).lineTo(summaryX + 200, doc.y).strokeColor(COLOR_HEADING).stroke();
  doc.y += 3;
  doc.moveTo(summaryX, doc.y).lineTo(summaryX + 200, doc.y).strokeColor(COLOR_HEADING).stroke();
  doc.y += 10;
  summaryRow("Total Due", fmtMoney(ctx.total, ctx.currency), true);

  renderPaymentAndNotes(doc, ctx, pageWidth, COLOR_LABEL);
  renderFooter(doc, ctx);
}

// ─────────────────────────────────────────────────────────────
// Minimal — whitespace, subtle borders, typography-first, understated
// totals. No card backgrounds, no heavy rules.
// ─────────────────────────────────────────────────────────────

function renderMinimalInvoice(doc: PDFKit.PDFDocument, ctx: Ctx, pageWidth: number) {
  const { template } = ctx;
  const fontReg = resolveFont(template.font, false);
  const fontBold = resolveFont(template.font, true);
  const rightColX = LEFT + pageWidth / 2 + 10;

  doc.y += 10;
  const headingX = headerColumnX(template.logoPosition, pageWidth, 220);
  renderLogo(doc, ctx, headingX);
  doc.font(fontReg).fontSize(18).fillColor(COLOR_HEADING).text("Invoice", headingX, doc.y);
  doc.font(fontReg).fontSize(9).fillColor(template.accentColor).text(ctx.invoiceNumber, headingX, doc.y);

  const dateBlockY = doc.page.margins.top + 10;
  doc.font(fontReg).fontSize(8).fillColor(COLOR_MUTED).text("Issued", rightColX, dateBlockY, { width: pageWidth / 2 - 10, align: "right" });
  doc.font(fontReg).fontSize(10).fillColor(COLOR_BODY).text(dayjs(ctx.issueDate).format("D MMMM YYYY"), rightColX, dateBlockY + 11, { width: pageWidth / 2 - 10, align: "right" });
  doc.font(fontReg).fontSize(8).fillColor(COLOR_MUTED).text("Due", rightColX, dateBlockY + 30, { width: pageWidth / 2 - 10, align: "right" });
  doc.font(fontReg).fontSize(10).fillColor(COLOR_BODY).text(dayjs(ctx.dueDate).format("D MMMM YYYY"), rightColX, dateBlockY + 41, { width: pageWidth / 2 - 10, align: "right" });

  doc.y = Math.max(doc.y, dateBlockY + 60) + 24;

  // Party blocks — no bold "cards", just plain text, generous spacing.
  const blockY = doc.y;
  const colWidth = pageWidth / 2 - 15;
  doc.font(fontReg).fontSize(8).fillColor(COLOR_MUTED).text("Bill to", LEFT, blockY);
  doc.font(fontReg).fontSize(11).fillColor(COLOR_HEADING).text(ctx.clientName, LEFT, blockY + 13, { width: colWidth });
  let billToY = doc.y + 2;
  if (ctx.clientAddress) {
    doc.font(fontReg).fontSize(9).fillColor(COLOR_MUTED).text(ctx.clientAddress, LEFT, billToY, { width: colWidth });
    billToY = doc.y + 2;
  }

  doc.font(fontReg).fontSize(8).fillColor(COLOR_MUTED).text("From", rightColX, blockY);
  doc.font(fontReg).fontSize(11).fillColor(COLOR_HEADING).text(ctx.companyName, rightColX, blockY + 13, { width: colWidth });
  let fromY = doc.y + 2;
  if (ctx.companyAddress) {
    doc.font(fontReg).fontSize(9).fillColor(COLOR_MUTED).text(ctx.companyAddress, rightColX, fromY, { width: colWidth });
    fromY = doc.y + 2;
  }

  doc.y = Math.max(billToY, fromY) + 28;

  renderServiceMeta(doc, ctx, pageWidth, COLOR_MUTED);
  doc.y += 10;

  // Line items — single-line rows, generous vertical rhythm, near-invisible dividers.
  const allBillable = [...ctx.lineItems.filter(isShiftItem), ...ctx.lineItems.filter(isLegacyItem), ...ctx.lineItems.filter(item => item.type === "adjustment")];

  for (const item of allBillable) {
    ensureSpace(doc, 36);
    const rowY = doc.y;
    doc.font(fontReg).fontSize(10).fillColor(COLOR_HEADING).text(item.description, LEFT, rowY, { width: pageWidth - 110 });
    doc.font(fontReg).fontSize(10).fillColor(COLOR_BODY).text(fmtMoney(item.amount, ctx.currency), LEFT + pageWidth - 100, rowY, { width: 100, align: "right" });

    const detail = item.type === "adjustment"
      ? "Adjustment"
      : [item.date ? dayjs(item.date).format("D MMM YYYY") : null, item.location].filter(Boolean).join(" · ");
    if (detail) {
      doc.font(fontReg).fontSize(8).fillColor(COLOR_MUTED).text(detail, LEFT, doc.y, { width: pageWidth - 110 });
    }

    doc.y += 22;
    doc.moveTo(LEFT, doc.y).lineTo(LEFT + pageWidth, doc.y).strokeColor("#F8FAFC").lineWidth(0.5).stroke();
    doc.lineWidth(1);
    doc.y += 14;
  }

  // Totals — no box, no rule, just right-aligned weight change.
  ensureSpace(doc, 80);
  doc.y += 16;
  const summaryX = LEFT + pageWidth - 220;

  doc.font(fontReg).fontSize(9).fillColor(COLOR_MUTED).text("Subtotal", summaryX, doc.y, { width: 120 });
  doc.font(fontReg).fontSize(9).fillColor(COLOR_BODY).text(fmtMoney(ctx.subtotal, ctx.currency), summaryX + 100, doc.y - 11, { width: 100, align: "right" });
  doc.y += 16;

  if (template.showVatBreakdown && ctx.vatRate > 0) {
    doc.font(fontReg).fontSize(9).fillColor(COLOR_MUTED).text(`VAT (${ctx.vatRate}%)`, summaryX, doc.y, { width: 120 });
    doc.font(fontReg).fontSize(9).fillColor(COLOR_BODY).text(fmtMoney(ctx.vatAmount, ctx.currency), summaryX + 100, doc.y - 11, { width: 100, align: "right" });
    doc.y += 16;
  }

  doc.y += 6;
  doc.font(fontReg).fontSize(14).fillColor(COLOR_HEADING).text("Total", summaryX, doc.y, { width: 120 });
  doc.font(fontReg).fontSize(14).fillColor(COLOR_HEADING).text(fmtMoney(ctx.total, ctx.currency), summaryX + 90, doc.y - 1, { width: 110, align: "right" });
  doc.y += 30;

  renderPaymentAndNotes(doc, ctx, pageWidth, COLOR_MUTED);
  renderFooter(doc, ctx);
}

// Builds the document only — the caller decides whether to pipe it to an
// HTTP response (download) or collect it into a Buffer (email attachment),
// same separation of concerns as timesheetPdf.ts's generateTimesheetPdf.
export const generateInvoicePdf = (opts: GenerateInvoicePdfOptions) => {
  const doc = new PDFDocument({ size: "A4", margin: 40 });
  const pageWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const template = opts.template ?? DEFAULT_INVOICE_TEMPLATE;
  const ctx: Ctx = { ...opts, template };

  switch (template.baseLayout) {
    case "classic":
      renderClassicInvoice(doc, ctx, pageWidth);
      break;
    case "minimal":
      renderMinimalInvoice(doc, ctx, pageWidth);
      break;
    case "modern":
    default:
      renderModernInvoice(doc, ctx, pageWidth);
      break;
  }

  return doc;
};
