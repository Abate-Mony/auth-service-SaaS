import PDFDocument from "pdfkit";
import dayjs from "dayjs";
import { DEFAULT_INVOICE_TEMPLATE, InvoicePdfTemplate } from "./invoicePdf.js";

// Reuses the exact same template shape as invoicePdf.ts (imported, not
// redeclared) — Quote draws from the same InvoiceTemplate pool as Invoice,
// see quoteModel.ts's comment on why. A separate type alias only so this
// file doesn't read as if it depends on invoices conceptually.
export type QuotePdfTemplate = InvoicePdfTemplate;

export interface QuotePdfLineItem {
  description: string;
  quantity: number;
  unitPrice: number;
  amount: number;
}

interface GenerateQuotePdfOptions {
  quoteNumber: string;

  companyName: string;
  companyAddress?: string;
  companyPhone?: string;

  clientName: string;
  clientAddress?: string;
  clientVatNumber?: string;

  title: string;
  description?: string;

  issueDate: Date | string;
  validUntil: Date | string;

  items: QuotePdfLineItem[];

  subtotal: number;
  taxRate: number;
  taxAmount: number;
  total: number;

  currency: string;
  notes?: string;
  terms?: string;

  template?: QuotePdfTemplate;
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

// Same substitution as invoicePdf.ts — see its own comment for why "Inter"
// isn't actually embedded yet.
const resolveFont = (font: QuotePdfTemplate["font"], bold: boolean): string => {
  if (font === "Times-Roman") return bold ? "Times-Bold" : "Times-Roman";
  return bold ? "Helvetica-Bold" : "Helvetica";
};

function ensureSpace(doc: PDFKit.PDFDocument, needed: number) {
  if (doc.y + needed > doc.page.height - 100) {
    doc.addPage({ size: "A4", margin: 40 });
    doc.y = 40;
  }
}

function headerColumnX(logoPosition: QuotePdfTemplate["logoPosition"], pageWidth: number, blockWidth: number): number {
  if (logoPosition === "top-center") return LEFT + (pageWidth - blockWidth) / 2;
  if (logoPosition === "top-right") return LEFT + pageWidth - blockWidth;
  return LEFT;
}

type Ctx = GenerateQuotePdfOptions & { template: QuotePdfTemplate };

function renderPartyBlocks(doc: PDFKit.PDFDocument, ctx: Ctx, pageWidth: number, opts: { labelColor: string; accentLabels: boolean }) {
  const { template } = ctx;
  const fontReg = resolveFont(template.font, false);
  const fontBold = resolveFont(template.font, true);
  const rightColX = LEFT + pageWidth / 2 + 10;
  const colWidth = pageWidth / 2 - 15;
  const blockY = doc.y;
  const labelColor = opts.accentLabels ? template.accentColor : opts.labelColor;

  doc.font(fontBold).fontSize(8).fillColor(labelColor).text("PREPARED FOR", LEFT, blockY);
  doc.font(fontBold).fontSize(12).fillColor(COLOR_HEADING).text(ctx.clientName, LEFT, blockY + 14, { width: colWidth });
  let toY = doc.y + 2;
  if (ctx.clientAddress) {
    doc.font(fontReg).fontSize(9).fillColor(COLOR_LABEL).text(ctx.clientAddress, LEFT, toY, { width: colWidth });
    toY = doc.y + 2;
  }
  if (ctx.clientVatNumber) {
    doc.font(fontReg).fontSize(9).fillColor(COLOR_LABEL).text(`VAT ${ctx.clientVatNumber}`, LEFT, toY, { width: colWidth });
    toY = doc.y + 2;
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

  doc.y = Math.max(toY, fromY) + 10;
}

// Reinterprets template.showPaymentTerms as "show the terms section" for
// this document type — see quoteModel.ts's templateSnapshot comment.
function renderTermsAndNotes(doc: PDFKit.PDFDocument, ctx: Ctx, pageWidth: number, labelColor: string) {
  const fontReg = resolveFont(ctx.template.font, false);
  const fontBold = resolveFont(ctx.template.font, true);

  if (ctx.template.showPaymentTerms && ctx.terms) {
    ensureSpace(doc, 50);
    doc.y += 14;
    doc.font(fontBold).fontSize(9).fillColor(labelColor).text("TERMS", LEFT, doc.y);
    doc.y += 14;
    doc.font(fontReg).fontSize(9).fillColor(COLOR_BODY).text(ctx.terms, LEFT, doc.y, { width: pageWidth });
  }

  if (ctx.template.showNotes && ctx.notes) {
    doc.y += 14;
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
// Modern
// ─────────────────────────────────────────────────────────────

function renderModernQuote(doc: PDFKit.PDFDocument, ctx: Ctx, pageWidth: number) {
  const { template } = ctx;
  const fontReg = resolveFont(template.font, false);
  const fontBold = resolveFont(template.font, true);
  const rightColX = LEFT + pageWidth / 2 + 10;

  const headingX = headerColumnX(template.logoPosition, pageWidth, 220);
  doc.font(fontBold).fontSize(22).fillColor(template.accentColor).text("QUOTE", headingX, doc.y);
  doc.font(fontBold).fontSize(11).fillColor(COLOR_LABEL).text(ctx.quoteNumber, headingX, doc.y);

  const dateBlockY = 40;
  doc.font(fontBold).fontSize(8).fillColor(COLOR_LABEL).text("ISSUED", rightColX, dateBlockY, { width: pageWidth / 2 - 10, align: "right" });
  doc.font(fontBold).fontSize(11).fillColor(COLOR_HEADING).text(dayjs(ctx.issueDate).format("D MMMM YYYY"), rightColX, dateBlockY + 12, { width: pageWidth / 2 - 10, align: "right" });
  doc.font(fontBold).fontSize(8).fillColor(COLOR_LABEL).text("VALID UNTIL", rightColX, dateBlockY + 34, { width: pageWidth / 2 - 10, align: "right" });
  doc.font(fontBold).fontSize(11).fillColor(COLOR_HEADING).text(dayjs(ctx.validUntil).format("D MMMM YYYY"), rightColX, dateBlockY + 46, { width: pageWidth / 2 - 10, align: "right" });

  doc.y = Math.max(doc.y, dateBlockY + 70);
  doc.rect(LEFT, doc.y, pageWidth, 3).fill(template.accentColor);
  doc.y += 3;
  doc.moveDown(1.2);

  renderPartyBlocks(doc, ctx, pageWidth, { labelColor: COLOR_LABEL, accentLabels: true });

  doc.font(fontBold).fontSize(15).fillColor(COLOR_HEADING).text(ctx.title, LEFT, doc.y, { width: pageWidth });
  if (ctx.description) {
    doc.font(fontReg).fontSize(10).fillColor(COLOR_BODY).text(ctx.description, LEFT, doc.y + 4, { width: pageWidth });
  }
  doc.y += 10;

  doc.moveTo(LEFT, doc.y + 4).lineTo(LEFT + pageWidth, doc.y + 4).strokeColor(COLOR_RULE).stroke();
  doc.y += 16;

  for (const item of ctx.items) {
    ensureSpace(doc, 40);
    const rowY = doc.y;
    doc.font(fontBold).fontSize(11).fillColor(COLOR_HEADING).text(item.description, LEFT, rowY, { width: pageWidth - 100 });
    doc.font(fontBold).fontSize(11).fillColor(COLOR_HEADING).text(fmtMoney(item.amount, ctx.currency), LEFT + pageWidth - 100, rowY, { width: 100, align: "right" });
    if (item.quantity !== 1 || item.unitPrice !== item.amount) {
      doc.font(fontReg).fontSize(9).fillColor(COLOR_LABEL).text(`${item.quantity} × ${fmtMoney(item.unitPrice, ctx.currency)}`, LEFT, rowY + 15, { width: pageWidth - 100 });
      doc.y = rowY + 30;
    } else {
      doc.y = rowY + 20;
    }
    doc.moveTo(LEFT, doc.y).lineTo(LEFT + pageWidth, doc.y).strokeColor("#F1F5F9").stroke();
    doc.y += 10;
  }

  ensureSpace(doc, 90);
  doc.y += 8;
  const summaryX = LEFT + pageWidth - 220;
  const summaryRow = (label: string, value: string) => {
    doc.font(fontReg).fontSize(10).fillColor(COLOR_LABEL).text(label, summaryX, doc.y, { width: 120 });
    doc.font(fontReg).fontSize(10).fillColor(COLOR_HEADING).text(value, summaryX + 100, doc.y - 12, { width: 100, align: "right" });
    doc.y += 16;
  };
  summaryRow("Subtotal", fmtMoney(ctx.subtotal, ctx.currency));
  if (template.showVatBreakdown && ctx.taxRate > 0) {
    summaryRow(`Tax (${ctx.taxRate}%)`, fmtMoney(ctx.taxAmount, ctx.currency));
  }
  doc.y += 4;
  doc.rect(summaryX - 12, doc.y, 220, 32).fill(`${template.accentColor}15`);
  doc.font(fontBold).fontSize(13).fillColor(template.accentColor).text("Total", summaryX, doc.y + 9, { width: 120 });
  doc.font(fontBold).fontSize(13).fillColor(template.accentColor).text(fmtMoney(ctx.total, ctx.currency), summaryX + 100, doc.y + 9, { width: 108, align: "right" });
  doc.y += 40;

  renderTermsAndNotes(doc, ctx, pageWidth, template.accentColor);
  renderFooter(doc, ctx);
}

// ─────────────────────────────────────────────────────────────
// Classic — ruled table, restrained branding
// ─────────────────────────────────────────────────────────────

function renderClassicQuote(doc: PDFKit.PDFDocument, ctx: Ctx, pageWidth: number) {
  const { template } = ctx;
  const fontReg = resolveFont(template.font, false);
  const fontBold = resolveFont(template.font, true);
  const rightColX = LEFT + pageWidth / 2 + 10;

  const headingX = headerColumnX(template.logoPosition, pageWidth, 220);
  doc.font(fontBold).fontSize(20).fillColor(COLOR_HEADING).text("QUOTE", headingX, doc.y);
  doc.font(fontReg).fontSize(10).fillColor(COLOR_LABEL).text(ctx.quoteNumber, headingX, doc.y);

  const dateBlockY = 40;
  doc.font(fontBold).fontSize(8).fillColor(COLOR_LABEL).text("ISSUED", rightColX, dateBlockY, { width: pageWidth / 2 - 10, align: "right" });
  doc.font(fontReg).fontSize(11).fillColor(COLOR_HEADING).text(dayjs(ctx.issueDate).format("D MMMM YYYY"), rightColX, dateBlockY + 12, { width: pageWidth / 2 - 10, align: "right" });
  doc.font(fontBold).fontSize(8).fillColor(COLOR_LABEL).text("VALID UNTIL", rightColX, dateBlockY + 34, { width: pageWidth / 2 - 10, align: "right" });
  doc.font(fontReg).fontSize(11).fillColor(COLOR_HEADING).text(dayjs(ctx.validUntil).format("D MMMM YYYY"), rightColX, dateBlockY + 46, { width: pageWidth / 2 - 10, align: "right" });

  doc.y = Math.max(doc.y, dateBlockY + 70);
  doc.moveTo(LEFT, doc.y).lineTo(LEFT + pageWidth, doc.y).strokeColor(template.accentColor).lineWidth(1.5).stroke();
  doc.lineWidth(1);
  doc.moveDown(1.2);

  renderPartyBlocks(doc, ctx, pageWidth, { labelColor: COLOR_LABEL, accentLabels: false });

  doc.font(fontBold).fontSize(14).fillColor(COLOR_HEADING).text(ctx.title, LEFT, doc.y, { width: pageWidth });
  if (ctx.description) {
    doc.font(fontReg).fontSize(10).fillColor(COLOR_BODY).text(ctx.description, LEFT, doc.y + 4, { width: pageWidth });
  }
  doc.y += 10;

  doc.moveTo(LEFT, doc.y + 4).lineTo(LEFT + pageWidth, doc.y + 4).strokeColor(COLOR_RULE).stroke();
  doc.y += 16;

  const colDesc = LEFT;
  const colDescW = pageWidth - 260;
  const colQty = LEFT + colDescW;
  const colQtyW = 90;
  const colRate = colQty + colQtyW;
  const colRateW = 80;
  const colAmount = colRate + colRateW;
  const colAmountW = pageWidth - colDescW - colQtyW - colRateW;

  if (ctx.items.length) {
    ensureSpace(doc, 30);
    const headerY = doc.y;
    doc.font(fontBold).fontSize(8).fillColor(COLOR_LABEL).text("DESCRIPTION", colDesc, headerY, { width: colDescW });
    doc.font(fontBold).fontSize(8).fillColor(COLOR_LABEL).text("QTY", colQty, headerY, { width: colQtyW, align: "right" });
    doc.font(fontBold).fontSize(8).fillColor(COLOR_LABEL).text("RATE", colRate, headerY, { width: colRateW, align: "right" });
    doc.font(fontBold).fontSize(8).fillColor(COLOR_LABEL).text("AMOUNT", colAmount, headerY, { width: colAmountW, align: "right" });
    doc.y = headerY + 14;
    doc.moveTo(LEFT, doc.y).lineTo(LEFT + pageWidth, doc.y).strokeColor(COLOR_HEADING).stroke();
    doc.y += 8;

    for (const item of ctx.items) {
      ensureSpace(doc, 26);
      const rowY = doc.y;
      doc.font(fontReg).fontSize(10).fillColor(COLOR_HEADING).text(item.description, colDesc, rowY, { width: colDescW });
      doc.font(fontReg).fontSize(10).fillColor(COLOR_BODY).text(String(item.quantity), colQty, rowY, { width: colQtyW, align: "right" });
      doc.font(fontReg).fontSize(10).fillColor(COLOR_BODY).text(fmtMoney(item.unitPrice, ctx.currency), colRate, rowY, { width: colRateW, align: "right" });
      doc.font(fontBold).fontSize(10).fillColor(COLOR_HEADING).text(fmtMoney(item.amount, ctx.currency), colAmount, rowY, { width: colAmountW, align: "right" });
      doc.y = Math.max(doc.y, rowY + 14) + 8;
      doc.moveTo(LEFT, doc.y).lineTo(LEFT + pageWidth, doc.y).strokeColor(COLOR_RULE).stroke();
      doc.y += 10;
    }
  }

  ensureSpace(doc, 90);
  doc.y += 8;
  const summaryX = LEFT + pageWidth - 220;
  const summaryRow = (label: string, value: string, bold = false) => {
    doc.font(bold ? fontBold : fontReg).fontSize(bold ? 12 : 10).fillColor(bold ? COLOR_HEADING : COLOR_LABEL).text(label, summaryX, doc.y, { width: 120 });
    doc.font(bold ? fontBold : fontReg).fontSize(bold ? 12 : 10).fillColor(COLOR_HEADING).text(value, summaryX + 100, doc.y - (bold ? 14 : 12), { width: 100, align: "right" });
    doc.y += bold ? 22 : 16;
  };
  summaryRow("Subtotal", fmtMoney(ctx.subtotal, ctx.currency));
  if (template.showVatBreakdown && ctx.taxRate > 0) {
    summaryRow(`Tax (${ctx.taxRate}%)`, fmtMoney(ctx.taxAmount, ctx.currency));
  }
  doc.moveTo(summaryX, doc.y).lineTo(summaryX + 200, doc.y).strokeColor(COLOR_HEADING).stroke();
  doc.y += 3;
  doc.moveTo(summaryX, doc.y).lineTo(summaryX + 200, doc.y).strokeColor(COLOR_HEADING).stroke();
  doc.y += 10;
  summaryRow("Total", fmtMoney(ctx.total, ctx.currency), true);

  renderTermsAndNotes(doc, ctx, pageWidth, COLOR_LABEL);
  renderFooter(doc, ctx);
}

// ─────────────────────────────────────────────────────────────
// Minimal — whitespace, typography-first
// ─────────────────────────────────────────────────────────────

function renderMinimalQuote(doc: PDFKit.PDFDocument, ctx: Ctx, pageWidth: number) {
  const { template } = ctx;
  const fontReg = resolveFont(template.font, false);
  const rightColX = LEFT + pageWidth / 2 + 10;

  doc.y += 10;
  const headingX = headerColumnX(template.logoPosition, pageWidth, 220);
  doc.font(fontReg).fontSize(18).fillColor(COLOR_HEADING).text("Quote", headingX, doc.y);
  doc.font(fontReg).fontSize(9).fillColor(template.accentColor).text(ctx.quoteNumber, headingX, doc.y);

  const dateBlockY = doc.page.margins.top + 10;
  doc.font(fontReg).fontSize(8).fillColor(COLOR_MUTED).text("Issued", rightColX, dateBlockY, { width: pageWidth / 2 - 10, align: "right" });
  doc.font(fontReg).fontSize(10).fillColor(COLOR_BODY).text(dayjs(ctx.issueDate).format("D MMMM YYYY"), rightColX, dateBlockY + 11, { width: pageWidth / 2 - 10, align: "right" });
  doc.font(fontReg).fontSize(8).fillColor(COLOR_MUTED).text("Valid until", rightColX, dateBlockY + 30, { width: pageWidth / 2 - 10, align: "right" });
  doc.font(fontReg).fontSize(10).fillColor(COLOR_BODY).text(dayjs(ctx.validUntil).format("D MMMM YYYY"), rightColX, dateBlockY + 41, { width: pageWidth / 2 - 10, align: "right" });

  doc.y = Math.max(doc.y, dateBlockY + 60) + 24;

  const blockY = doc.y;
  const colWidth = pageWidth / 2 - 15;
  doc.font(fontReg).fontSize(8).fillColor(COLOR_MUTED).text("Prepared for", LEFT, blockY);
  doc.font(fontReg).fontSize(11).fillColor(COLOR_HEADING).text(ctx.clientName, LEFT, blockY + 13, { width: colWidth });
  let toY = doc.y + 2;
  if (ctx.clientAddress) {
    doc.font(fontReg).fontSize(9).fillColor(COLOR_MUTED).text(ctx.clientAddress, LEFT, toY, { width: colWidth });
    toY = doc.y + 2;
  }

  doc.font(fontReg).fontSize(8).fillColor(COLOR_MUTED).text("From", rightColX, blockY);
  doc.font(fontReg).fontSize(11).fillColor(COLOR_HEADING).text(ctx.companyName, rightColX, blockY + 13, { width: colWidth });
  let fromY = doc.y + 2;
  if (ctx.companyAddress) {
    doc.font(fontReg).fontSize(9).fillColor(COLOR_MUTED).text(ctx.companyAddress, rightColX, fromY, { width: colWidth });
    fromY = doc.y + 2;
  }

  doc.y = Math.max(toY, fromY) + 24;

  doc.font(fontReg).fontSize(13).fillColor(COLOR_HEADING).text(ctx.title, LEFT, doc.y, { width: pageWidth });
  if (ctx.description) {
    doc.font(fontReg).fontSize(9).fillColor(COLOR_MUTED).text(ctx.description, LEFT, doc.y + 4, { width: pageWidth });
  }
  doc.y += 28;

  for (const item of ctx.items) {
    ensureSpace(doc, 34);
    const rowY = doc.y;
    doc.font(fontReg).fontSize(10).fillColor(COLOR_HEADING).text(item.description, LEFT, rowY, { width: pageWidth - 110 });
    doc.font(fontReg).fontSize(10).fillColor(COLOR_BODY).text(fmtMoney(item.amount, ctx.currency), LEFT + pageWidth - 100, rowY, { width: 100, align: "right" });
    if (item.quantity !== 1) {
      doc.font(fontReg).fontSize(8).fillColor(COLOR_MUTED).text(`${item.quantity} × ${fmtMoney(item.unitPrice, ctx.currency)}`, LEFT, doc.y, { width: pageWidth - 110 });
    }
    doc.y += 22;
    doc.moveTo(LEFT, doc.y).lineTo(LEFT + pageWidth, doc.y).strokeColor("#F8FAFC").lineWidth(0.5).stroke();
    doc.lineWidth(1);
    doc.y += 14;
  }

  ensureSpace(doc, 80);
  doc.y += 16;
  const summaryX = LEFT + pageWidth - 220;
  doc.font(fontReg).fontSize(9).fillColor(COLOR_MUTED).text("Subtotal", summaryX, doc.y, { width: 120 });
  doc.font(fontReg).fontSize(9).fillColor(COLOR_BODY).text(fmtMoney(ctx.subtotal, ctx.currency), summaryX + 100, doc.y - 11, { width: 100, align: "right" });
  doc.y += 16;
  if (template.showVatBreakdown && ctx.taxRate > 0) {
    doc.font(fontReg).fontSize(9).fillColor(COLOR_MUTED).text(`Tax (${ctx.taxRate}%)`, summaryX, doc.y, { width: 120 });
    doc.font(fontReg).fontSize(9).fillColor(COLOR_BODY).text(fmtMoney(ctx.taxAmount, ctx.currency), summaryX + 100, doc.y - 11, { width: 100, align: "right" });
    doc.y += 16;
  }
  doc.y += 6;
  doc.font(fontReg).fontSize(14).fillColor(COLOR_HEADING).text("Total", summaryX, doc.y, { width: 120 });
  doc.font(fontReg).fontSize(14).fillColor(COLOR_HEADING).text(fmtMoney(ctx.total, ctx.currency), summaryX + 90, doc.y - 1, { width: 110, align: "right" });
  doc.y += 30;

  renderTermsAndNotes(doc, ctx, pageWidth, COLOR_MUTED);
  renderFooter(doc, ctx);
}

export const generateQuotePdf = (opts: GenerateQuotePdfOptions) => {
  const doc = new PDFDocument({ size: "A4", margin: 40 });
  const pageWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const template = opts.template ?? DEFAULT_INVOICE_TEMPLATE;
  const ctx: Ctx = { ...opts, template };

  switch (template.baseLayout) {
    case "classic":
      renderClassicQuote(doc, ctx, pageWidth);
      break;
    case "minimal":
      renderMinimalQuote(doc, ctx, pageWidth);
      break;
    case "modern":
    default:
      renderModernQuote(doc, ctx, pageWidth);
      break;
  }

  return doc;
};
