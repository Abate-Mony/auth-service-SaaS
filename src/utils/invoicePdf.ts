import PDFDocument from "pdfkit";
import dayjs from "dayjs";

export interface InvoicePdfLineItem {
  description: string;
  hours: number;
  rate: number;
  amount: number;
}

interface GenerateInvoicePdfOptions {
  invoiceNumber: string;
  companyName: string;

  clientName: string;
  clientAddress?: string;

  issueDate: Date | string;
  dueDate: Date | string;

  lineItems: InvoicePdfLineItem[];

  subtotal: number;
  vatRate: number;
  vatAmount: number;
  total: number;

  currency: string;
  notes?: string;
}

const fmtMoney = (amount: number, currency: string) => {
  const symbol = currency === "USD" ? "$" : currency === "EUR" ? "€" : "£";
  return `${symbol}${amount.toFixed(2)}`;
};

// Builds the document only — the caller decides whether to pipe it to an
// HTTP response (download) or collect it into a Buffer (email attachment),
// same separation of concerns as timesheetPdf.ts's generateTimesheetPdf.
export const generateInvoicePdf = ({
  invoiceNumber,
  companyName,
  clientName,
  clientAddress,
  issueDate,
  dueDate,
  lineItems,
  subtotal,
  vatRate,
  vatAmount,
  total,
  currency,
  notes,
}: GenerateInvoicePdfOptions) => {
  const doc = new PDFDocument({
    size: "A4",
    margin: 40,
  });

  const pageWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;

  // ─────────────────────────────────────
  // Header
  // ─────────────────────────────────────

  doc.font("Helvetica-Bold").fontSize(26).fillColor("#0F172A").text("INVOICE", { align: "left" });

  doc.font("Helvetica").fontSize(10).fillColor("#64748B").text(companyName, { align: "right" });

  doc.moveDown(1);

  const headerY = doc.y;

  doc.font("Helvetica-Bold").fontSize(9).fillColor("#64748B").text("INVOICE NUMBER", 40, headerY);
  doc.font("Helvetica-Bold").fontSize(13).fillColor("#0F172A").text(invoiceNumber, 40, headerY + 18);

  doc.font("Helvetica-Bold").fontSize(9).fillColor("#64748B").text("BILL TO", 270, headerY);
  doc.font("Helvetica-Bold").fontSize(13).fillColor("#0F172A").text(clientName, 270, headerY + 18);
  if (clientAddress) {
    doc.font("Helvetica").fontSize(9).fillColor("#64748B").text(clientAddress, 270, headerY + 36, { width: 200 });
  }

  doc.font("Helvetica-Bold").fontSize(9).fillColor("#64748B").text("ISSUED", 460, headerY);
  doc.font("Helvetica-Bold").fontSize(11).fillColor("#0F172A").text(dayjs(issueDate).format("DD/MM/YYYY"), 460, headerY + 18);

  doc.font("Helvetica-Bold").fontSize(9).fillColor("#64748B").text("DUE", 460, headerY + 42);
  doc.font("Helvetica-Bold").fontSize(11).fillColor("#0F172A").text(dayjs(dueDate).format("DD/MM/YYYY"), 460, headerY + 60);

  doc.y = headerY + 90;

  doc.moveTo(40, doc.y).lineTo(40 + pageWidth, doc.y).strokeColor("#E2E8F0").stroke();
  doc.moveDown(1.5);

  // ─────────────────────────────────────
  // Line items table
  // ─────────────────────────────────────

  const tableX = 40;
  const rowHeight = 30;

  const columns = [
    { label: "DESCRIPTION", width: 260 },
    { label: "HOURS", width: 80 },
    { label: "RATE", width: 90 },
    { label: "AMOUNT", width: 85 },
  ];

  const tableWidth = columns.reduce((total, column) => total + column.width, 0);

  const drawTableHeader = (y: number) => {
    doc.roundedRect(tableX, y, tableWidth, rowHeight, 5).fill("#F8FAFC");

    let x = tableX;
    columns.forEach(column => {
      doc
        .font("Helvetica-Bold")
        .fontSize(8)
        .fillColor("#64748B")
        .text(column.label, x + 8, y + 11, {
          width: column.width - 16,
          align: column.label === "DESCRIPTION" ? "left" : "right",
        });
      x += column.width;
    });
  };

  let y = doc.y;
  drawTableHeader(y);
  y += rowHeight;

  lineItems.forEach(item => {
    if (y + rowHeight > doc.page.height - 150) {
      doc.addPage({ size: "A4", margin: 40 });
      y = 40;
      drawTableHeader(y);
      y += rowHeight;
    }

    doc.moveTo(tableX, y + rowHeight).lineTo(tableX + tableWidth, y + rowHeight).strokeColor("#E2E8F0").stroke();

    const values = [item.description, item.hours.toFixed(2), fmtMoney(item.rate, currency), fmtMoney(item.amount, currency)];

    let x = tableX;
    columns.forEach((column, index) => {
      doc
        .font("Helvetica")
        .fontSize(9)
        .fillColor("#334155")
        .text(values[index], x + 8, y + 10, {
          width: column.width - 16,
          align: index === 0 ? "left" : "right",
          ellipsis: true,
        });
      x += column.width;
    });

    y += rowHeight;
  });

  // ─────────────────────────────────────
  // Totals
  // ─────────────────────────────────────

  y += 20;
  const summaryX = tableX + tableWidth - 220;

  const summaryRow = (label: string, value: string, bold = false) => {
    doc
      .font(bold ? "Helvetica-Bold" : "Helvetica")
      .fontSize(bold ? 12 : 10)
      .fillColor(bold ? "#0F172A" : "#64748B")
      .text(label, summaryX, y, { width: 120 });

    doc
      .font(bold ? "Helvetica-Bold" : "Helvetica")
      .fontSize(bold ? 12 : 10)
      .fillColor("#0F172A")
      .text(value, summaryX + 100, y, { width: 100, align: "right" });

    y += bold ? 26 : 20;
  };

  summaryRow("Subtotal", fmtMoney(subtotal, currency));
  if (vatRate > 0) {
    summaryRow(`VAT (${vatRate}%)`, fmtMoney(vatAmount, currency));
  }

  doc.moveTo(summaryX, y).lineTo(summaryX + 200, y).strokeColor("#CBD5E1").stroke();
  y += 12;

  summaryRow("Total due", fmtMoney(total, currency), true);

  // ─────────────────────────────────────
  // Notes
  // ─────────────────────────────────────

  if (notes) {
    y += 24;
    doc.font("Helvetica-Bold").fontSize(9).fillColor("#64748B").text("NOTES", tableX, y);
    y += 16;
    doc.font("Helvetica").fontSize(9).fillColor("#334155").text(notes, tableX, y, { width: pageWidth });
  }

  // Footer
  doc
    .font("Helvetica")
    .fontSize(8)
    .fillColor("#94A3B8")
    .text(`Generated ${dayjs().format("DD MMM YYYY HH:mm")} by ${companyName}`, 40, doc.page.height - 40, { align: "left" });

  return doc;
};
