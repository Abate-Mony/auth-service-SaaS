import PDFDocument from "pdfkit";
import dayjs from "dayjs";

export interface TimesheetPdfRow {
  date: Date | string;
  jobTitle: string;
  location: string;
  startTime: string;
  endTime: string;
  breakMinutes: number;
  workedMinutes: number;
  /** Extra time still awaiting manager approval — not included in workedMinutes' payable total. */
  pendingOvertimeMinutes?: number;
}

interface GenerateTimesheetPdfOptions {
  employeeName: string;
  employeeEmail?: string;

  companyName: string;

  periodStart: Date | string;
  periodEnd: Date | string;

  rows: TimesheetPdfRow[];

  regularMinutes: number;
  overtimeMinutes: number;
}

const formatMinutes = (minutes: number) => {
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;

  if (!mins) return `${hours}h`;

  return `${hours}h ${mins}m`;
};

const formatHoursDecimal = (minutes: number) =>
  (minutes / 60).toFixed(2);

export const generateTimesheetPdf = ({
  employeeName,
  employeeEmail,
  companyName,
  periodStart,
  periodEnd,
  rows,
  regularMinutes,
  overtimeMinutes,
}: GenerateTimesheetPdfOptions) => {
  /*
   * Landscape A4 gives us enough room for:
   * Date, Job, Location, Start, End, Break, Hours
   */
  const doc = new PDFDocument({
    size: "A4",
    layout: "landscape",
    margin: 40,
  });

  const pageWidth =
    doc.page.width -
    doc.page.margins.left -
    doc.page.margins.right;

  // ─────────────────────────────────────
  // Header
  // ─────────────────────────────────────

  doc
    .font("Helvetica-Bold")
    .fontSize(26)
    .fillColor("#0F172A")
    .text("TIMESHEET", {
      align: "left",
    });

  doc
    .font("Helvetica")
    .fontSize(10)
    .fillColor("#64748B")
    .text("work.wrk", {
      align: "right",
    });

  doc.moveDown(1);

  const headerY = doc.y;

  // Employee
  doc
    .font("Helvetica-Bold")
    .fontSize(9)
    .fillColor("#64748B")
    .text("EMPLOYEE", 40, headerY);

  doc
    .font("Helvetica-Bold")
    .fontSize(13)
    .fillColor("#0F172A")
    .text(employeeName, 40, headerY + 18);

  if (employeeEmail) {
    doc
      .font("Helvetica")
      .fontSize(9)
      .fillColor("#64748B")
      .text(employeeEmail, 40, headerY + 36);
  }

  // Company
  doc
    .font("Helvetica-Bold")
    .fontSize(9)
    .fillColor("#64748B")
    .text("COMPANY", 270, headerY);

  doc
    .font("Helvetica-Bold")
    .fontSize(13)
    .fillColor("#0F172A")
    .text(companyName, 270, headerY + 18);

  // Period
  doc
    .font("Helvetica-Bold")
    .fontSize(9)
    .fillColor("#64748B")
    .text("PERIOD", 520, headerY);

  doc
    .font("Helvetica-Bold")
    .fontSize(13)
    .fillColor("#0F172A")
    .text(
      `${dayjs(periodStart).format("DD/MM/YYYY")} — ${dayjs(
        periodEnd
      ).format("DD/MM/YYYY")}`,
      520,
      headerY + 18
    );

  doc.y = headerY + 70;

  // Divider
  doc
    .moveTo(40, doc.y)
    .lineTo(40 + pageWidth, doc.y)
    .strokeColor("#E2E8F0")
    .stroke();

  doc.moveDown(1.5);

  // ─────────────────────────────────────
  // Table
  // ─────────────────────────────────────

  const tableX = 40;
  const rowHeight = 32;

  const columns = [
    { label: "DATE", width: 80 },
    { label: "JOB", width: 130 },
    { label: "LOCATION", width: 230 },
    { label: "START", width: 65 },
    { label: "END", width: 65 },
    { label: "BREAK", width: 70 },
    { label: "HOURS", width: 70 },
  ];

  const tableWidth = columns.reduce(
    (total, column) => total + column.width,
    0
  );

  const drawTableHeader = (y: number) => {
    doc
      .roundedRect(
        tableX,
        y,
        tableWidth,
        rowHeight,
        5
      )
      .fill("#F8FAFC");

    let x = tableX;

    columns.forEach((column) => {
      doc
        .font("Helvetica-Bold")
        .fontSize(8)
        .fillColor("#64748B")
        .text(
          column.label,
          x + 8,
          y + 11,
          {
            width: column.width - 16,
          }
        );

      x += column.width;
    });
  };

  let y = doc.y;

  drawTableHeader(y);

  y += rowHeight;

  rows.forEach((row) => {
    // New page if needed
    if (y + rowHeight > doc.page.height - 100) {
      doc.addPage({
        size: "A4",
        layout: "landscape",
        margin: 40,
      });

      y = 40;

      drawTableHeader(y);

      y += rowHeight;
    }

    doc
      .moveTo(tableX, y + rowHeight)
      .lineTo(
        tableX + tableWidth,
        y + rowHeight
      )
      .strokeColor("#E2E8F0")
      .stroke();

    const values = [
      dayjs(row.date).format("DD MMM"),
      row.jobTitle,
      row.location || "—",
      row.startTime,
      row.endTime,
      row.breakMinutes
        ? formatMinutes(row.breakMinutes)
        : "—",
      row.pendingOvertimeMinutes
        ? `${formatHoursDecimal(row.workedMinutes)} (+${formatHoursDecimal(row.pendingOvertimeMinutes)} pending)`
        : formatHoursDecimal(row.workedMinutes),
    ];

    let x = tableX;

    columns.forEach((column, index) => {
      doc
        .font("Helvetica")
        .fontSize(9)
        .fillColor("#334155")
        .text(
          values[index],
          x + 8,
          y + 10,
          {
            width: column.width - 16,
            ellipsis: true,
          }
        );

      x += column.width;
    });

    y += rowHeight;
  });

  // Empty state
  if (rows.length === 0) {
    doc
      .font("Helvetica")
      .fontSize(10)
      .fillColor("#94A3B8")
      .text(
        "No completed shifts were found for this period.",
        tableX,
        y + 16
      );

    y += 50;
  }

  // ─────────────────────────────────────
  // Summary
  // ─────────────────────────────────────

  const totalMinutes =
    regularMinutes + overtimeMinutes;

  y += 28;

  const summaryX = tableX + tableWidth - 250;

  const summaryRow = (
    label: string,
    value: string,
    bold = false
  ) => {
    doc
      .font(
        bold
          ? "Helvetica-Bold"
          : "Helvetica"
      )
      .fontSize(bold ? 12 : 10)
      .fillColor(
        bold
          ? "#0F172A"
          : "#64748B"
      )
      .text(label, summaryX, y, {
        width: 120,
      });

    doc
      .font(
        bold
          ? "Helvetica-Bold"
          : "Helvetica"
      )
      .fontSize(bold ? 12 : 10)
      .fillColor("#0F172A")
      .text(value, summaryX + 130, y, {
        width: 100,
        align: "right",
      });

    y += bold ? 26 : 22;
  };

  summaryRow(
    "Regular hours",
    formatHoursDecimal(regularMinutes)
  );

  summaryRow(
    "Overtime",
    formatHoursDecimal(overtimeMinutes)
  );

  doc
    .moveTo(summaryX, y)
    .lineTo(summaryX + 230, y)
    .strokeColor("#CBD5E1")
    .stroke();

  y += 12;

  summaryRow(
    "Total hours",
    formatHoursDecimal(totalMinutes),
    true
  );

  // Footer
  doc
    .font("Helvetica")
    .fontSize(8)
    .fillColor("#94A3B8")
    .text(
      `Generated ${dayjs().format(
        "DD MMM YYYY HH:mm"
      )} by work.wrk`,
      40,
      doc.page.height - 40,
      {
        align: "left",
      }
    );

  return doc;
};