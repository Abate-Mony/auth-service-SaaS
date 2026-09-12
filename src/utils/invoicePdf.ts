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

// "Real" work: hourly/fixed lines with a snapshot date — everything that
// existed before this line-item shape was introduced (or a generic manual
// item) has no date and renders as a plain legacy charge instead, rather
// than crashing on missing job/shift metadata.
const isShiftItem = (item: InvoicePdfLineItem) => item.type !== "adjustment" && !!item.date;
const isLegacyItem = (item: InvoicePdfLineItem) => item.type !== "adjustment" && !item.date;

// Builds the document only — the caller decides whether to pipe it to an
// HTTP response (download) or collect it into a Buffer (email attachment),
// same separation of concerns as timesheetPdf.ts's generateTimesheetPdf.
export const generateInvoicePdf = ({
  invoiceNumber,
  companyName,
  companyAddress,
  companyPhone,
  clientName,
  clientAddress,
  clientVatNumber,
  issueDate,
  dueDate,
  servicePeriod,
  lineItems,
  subtotal,
  vatRate,
  vatAmount,
  total,
  currency,
  purchaseOrderNumber,
  notes,
}: GenerateInvoicePdfOptions) => {
  const doc = new PDFDocument({ size: "A4", margin: 40 });
  const pageWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const rightColX = LEFT + pageWidth / 2 + 10;

  const ensureSpace = (needed: number) => {
    if (doc.y + needed > doc.page.height - 100) {
      doc.addPage({ size: "A4", margin: 40 });
      doc.y = 40;
    }
  };

  // ─────────────────────────────────────
  // Header
  // ─────────────────────────────────────
  doc.font("Helvetica-Bold").fontSize(22).fillColor(COLOR_HEADING).text("INVOICE", LEFT, doc.y, { continued: false });
  doc.font("Helvetica-Bold").fontSize(11).fillColor(COLOR_LABEL).text(invoiceNumber, LEFT, doc.y);

  const dateBlockY = 40;
  doc.font("Helvetica-Bold").fontSize(8).fillColor(COLOR_LABEL).text("ISSUED", rightColX, dateBlockY, { width: pageWidth / 2 - 10, align: "right" });
  doc.font("Helvetica-Bold").fontSize(11).fillColor(COLOR_HEADING).text(dayjs(issueDate).format("D MMMM YYYY"), rightColX, dateBlockY + 12, { width: pageWidth / 2 - 10, align: "right" });
  doc.font("Helvetica-Bold").fontSize(8).fillColor(COLOR_LABEL).text("DUE", rightColX, dateBlockY + 34, { width: pageWidth / 2 - 10, align: "right" });
  doc.font("Helvetica-Bold").fontSize(11).fillColor(COLOR_HEADING).text(dayjs(dueDate).format("D MMMM YYYY"), rightColX, dateBlockY + 46, { width: pageWidth / 2 - 10, align: "right" });

  doc.y = Math.max(doc.y, dateBlockY + 70);
  doc.moveTo(LEFT, doc.y).lineTo(LEFT + pageWidth, doc.y).strokeColor(COLOR_RULE).stroke();
  doc.moveDown(1.2);

  // ─────────────────────────────────────
  // Bill To / From
  // ─────────────────────────────────────
  const blockY = doc.y;
  const colWidth = pageWidth / 2 - 15;

  doc.font("Helvetica-Bold").fontSize(8).fillColor(COLOR_LABEL).text("BILL TO", LEFT, blockY);
  doc.font("Helvetica-Bold").fontSize(12).fillColor(COLOR_HEADING).text(clientName, LEFT, blockY + 14, { width: colWidth });
  let billToY = doc.y + 2;
  if (clientAddress) {
    doc.font("Helvetica").fontSize(9).fillColor(COLOR_LABEL).text(clientAddress, LEFT, billToY, { width: colWidth });
    billToY = doc.y + 2;
  }
  if (clientVatNumber) {
    doc.font("Helvetica").fontSize(9).fillColor(COLOR_LABEL).text(`VAT ${clientVatNumber}`, LEFT, billToY, { width: colWidth });
    billToY = doc.y + 2;
  }

  doc.font("Helvetica-Bold").fontSize(8).fillColor(COLOR_LABEL).text("FROM", rightColX, blockY);
  doc.font("Helvetica-Bold").fontSize(12).fillColor(COLOR_HEADING).text(companyName, rightColX, blockY + 14, { width: colWidth });
  let fromY = doc.y + 2;
  if (companyAddress) {
    doc.font("Helvetica").fontSize(9).fillColor(COLOR_LABEL).text(companyAddress, rightColX, fromY, { width: colWidth });
    fromY = doc.y + 2;
  }
  if (companyPhone) {
    doc.font("Helvetica").fontSize(9).fillColor(COLOR_LABEL).text(companyPhone, rightColX, fromY, { width: colWidth });
    fromY = doc.y + 2;
  }

  doc.y = Math.max(billToY, fromY) + 10;

  if (servicePeriod?.start && servicePeriod?.end) {
    doc.font("Helvetica-Bold").fontSize(8).fillColor(COLOR_LABEL).text("SERVICE PERIOD", LEFT, doc.y);
    doc.font("Helvetica").fontSize(10).fillColor(COLOR_BODY).text(
      `${dayjs(servicePeriod.start).format("D MMM YYYY")} – ${dayjs(servicePeriod.end).format("D MMM YYYY")}`,
      LEFT,
      doc.y + 2
    );
    doc.moveDown(0.8);
  }

  if (purchaseOrderNumber) {
    doc.font("Helvetica").fontSize(9).fillColor(COLOR_LABEL).text(`PO / Reference: ${purchaseOrderNumber}`, LEFT, doc.y);
    doc.moveDown(0.5);
  }

  doc.moveTo(LEFT, doc.y + 4).lineTo(LEFT + pageWidth, doc.y + 4).strokeColor(COLOR_RULE).stroke();
  doc.y += 16;

  // ─────────────────────────────────────
  // Work completed — job/shift cards, not a generic table
  // ─────────────────────────────────────
  const shiftItems = lineItems.filter(isShiftItem);
  const legacyItems = lineItems.filter(isLegacyItem);
  const adjustmentItems = lineItems.filter(item => item.type === "adjustment");

  if (shiftItems.length || adjustmentItems.length) {
    doc.font("Helvetica-Bold").fontSize(9).fillColor(COLOR_LABEL).text("WORK COMPLETED", LEFT, doc.y);
    doc.y += 16;

    for (const item of shiftItems) {
      ensureSpace(50);
      const rowY = doc.y;

      doc.font("Helvetica-Bold").fontSize(11).fillColor(COLOR_HEADING).text(item.description, LEFT, rowY, { width: pageWidth - 100 });
      doc.font("Helvetica-Bold").fontSize(11).fillColor(COLOR_HEADING).text(fmtMoney(item.amount, currency), LEFT + pageWidth - 100, rowY, { width: 100, align: "right" });

      let y = rowY + 15;
      const detailParts = [item.date ? dayjs(item.date).format("D MMMM YYYY") : null, item.location].filter(Boolean);
      if (detailParts.length) {
        doc.font("Helvetica").fontSize(9).fillColor(COLOR_LABEL).text(detailParts.join(" · "), LEFT, y, { width: pageWidth - 100 });
        y += 13;
      }

      // Hours shown here are derived from the actual charged amount, not
      // the raw stored quantity — that quantity is independently rounded to
      // 2dp elsewhere (eligibility.ts) and can be a penny off when
      // multiplied back out against the rate (e.g. 50 minutes at £18/hour
      // is a real £15.00, but 50/60 rounds to "0.83h", and 0.83 × £18 is
      // £14.94). Deriving from amount/rate instead guarantees this line
      // always reads consistently with the amount printed next to it.
      const displayHours = item.type === "hourly" && item.rate > 0 ? Math.round((item.amount / item.rate) * 100) / 100 : item.hours;
      const billingLine =
        item.type === "hourly"
          ? `${item.startTime && item.endTime ? `${item.startTime}–${item.endTime} · ` : ""}${displayHours}h × ${fmtMoney(item.rate, currency)}/hour`
          : "Fixed job charge";
      doc.font("Helvetica").fontSize(9).fillColor(COLOR_BODY).text(billingLine, LEFT, y, { width: pageWidth - 100 });
      y += 13;

      doc.y = y + 8;
      doc.moveTo(LEFT, doc.y).lineTo(LEFT + pageWidth, doc.y).strokeColor("#F1F5F9").stroke();
      doc.y += 10;
    }

    for (const item of adjustmentItems) {
      ensureSpace(35);
      const rowY = doc.y;
      doc.font("Helvetica-Bold").fontSize(8).fillColor(COLOR_MUTED).text("ADJUSTMENT", LEFT, rowY);
      doc.font("Helvetica").fontSize(11).fillColor(COLOR_HEADING).text(item.description, LEFT, rowY + 12, { width: pageWidth - 100 });
      doc.font("Helvetica-Bold").fontSize(11).fillColor(item.amount < 0 ? "#DC2626" : COLOR_HEADING).text(fmtMoney(item.amount, currency), LEFT + pageWidth - 100, rowY + 12, { width: 100, align: "right" });
      doc.y = rowY + 30;
      doc.moveTo(LEFT, doc.y).lineTo(LEFT + pageWidth, doc.y).strokeColor("#F1F5F9").stroke();
      doc.y += 10;
    }
  }

  // Legacy fallback — older invoices (or generic manual entries) with no
  // shift snapshot render as plain charges instead of crashing on absent
  // job/date/location.
  if (legacyItems.length) {
    ensureSpace(20);
    doc.font("Helvetica-Bold").fontSize(9).fillColor(COLOR_LABEL).text("OTHER CHARGES", LEFT, doc.y);
    doc.y += 16;

    for (const item of legacyItems) {
      ensureSpace(30);
      const rowY = doc.y;
      doc.font("Helvetica").fontSize(10).fillColor(COLOR_BODY).text(item.description, LEFT, rowY, { width: pageWidth - 180 });
      if (item.hours) {
        doc.font("Helvetica").fontSize(9).fillColor(COLOR_LABEL).text(`${item.hours}h × ${fmtMoney(item.rate, currency)}/hr`, LEFT, rowY + 13);
      }
      doc.font("Helvetica-Bold").fontSize(10).fillColor(COLOR_HEADING).text(fmtMoney(item.amount, currency), LEFT + pageWidth - 100, rowY, { width: 100, align: "right" });
      doc.y = rowY + (item.hours ? 28 : 18);
      doc.moveTo(LEFT, doc.y).lineTo(LEFT + pageWidth, doc.y).strokeColor("#F1F5F9").stroke();
      doc.y += 10;
    }
  }

  // ─────────────────────────────────────
  // Totals
  // ─────────────────────────────────────
  ensureSpace(90);
  doc.y += 8;
  const summaryX = LEFT + pageWidth - 220;

  const summaryRow = (label: string, value: string, bold = false) => {
    doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(bold ? 12 : 10).fillColor(bold ? COLOR_HEADING : COLOR_LABEL).text(label, summaryX, doc.y, { width: 120, continued: false });
    doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(bold ? 12 : 10).fillColor(COLOR_HEADING).text(value, summaryX + 100, doc.y - (bold ? 14 : 12), { width: 100, align: "right" });
    doc.y += bold ? 22 : 16;
  };

  summaryRow("Subtotal", fmtMoney(subtotal, currency));
  if (vatRate > 0) {
    summaryRow(`VAT (${vatRate}%)`, fmtMoney(vatAmount, currency));
  }
  doc.moveTo(summaryX, doc.y).lineTo(summaryX + 200, doc.y).strokeColor("#CBD5E1").stroke();
  doc.y += 10;
  summaryRow("Total", fmtMoney(total, currency), true);

  // ─────────────────────────────────────
  // Payment details
  // ─────────────────────────────────────
  ensureSpace(60);
  doc.y += 14;
  doc.font("Helvetica-Bold").fontSize(9).fillColor(COLOR_LABEL).text("PAYMENT DETAILS", LEFT, doc.y);
  doc.y += 14;
  doc.font("Helvetica").fontSize(9).fillColor(COLOR_BODY).text(`Payment due by ${dayjs(dueDate).format("D MMMM YYYY")}`, LEFT, doc.y);
  doc.y += 13;
  doc.font("Helvetica").fontSize(9).fillColor(COLOR_BODY).text(`Reference: ${invoiceNumber}`, LEFT, doc.y);
  doc.y += 13;

  if (notes) {
    doc.y += 10;
    doc.font("Helvetica-Bold").fontSize(9).fillColor(COLOR_LABEL).text("NOTES", LEFT, doc.y);
    doc.y += 14;
    doc.font("Helvetica").fontSize(9).fillColor(COLOR_BODY).text(notes, LEFT, doc.y, { width: pageWidth });
  }

  // Footer
  doc.font("Helvetica").fontSize(8).fillColor(COLOR_MUTED).text(`Generated ${dayjs().format("D MMM YYYY HH:mm")} by ${companyName}`, LEFT, doc.page.height - 40, { align: "left" });

  return doc;
};
