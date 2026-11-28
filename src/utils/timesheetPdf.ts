import PDFDocument from "pdfkit";
import dayjs from "dayjs";
import { describeRates, hoursDecimal, weekStartOf } from "./timesheetFormat.js";

export interface TimesheetPdfRow {
  /** Calendar day of the shift, "YYYY-MM-DD" (already in the company's time zone). */
  dayKey: string;
  jobTitle: string;
  /** One tidy address line — see cleanAddress(). */
  address: string;
  /** Actual clock-in / clock-out, "HH:mm" in the company's time zone. */
  startTime: string;
  endTime: string;
  breakMinutes: number;
  /** What payroll pays for this shift (capped unless overtime was approved). */
  paidMinutes: number;
  /** Approved overtime — included in paidMinutes. */
  approvedOvertimeMinutes?: number;
  /** Overtime a manager declined — worked but not paid. */
  declinedOvertimeMinutes?: number;
  /** Overtime still waiting for a manager — not paid yet. */
  pendingOvertimeMinutes?: number;
  /** The shift's pay rate, for the "Rates" summary. */
  payRate?: number | null;
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
  /** Omit entirely to keep the PDF hours-only (e.g. a copy meant for a client). */
  pay?: {
    regularPay: number;
    overtimePay: number;
    currency: string;
    overtimeMultiplier: number;
  };
  // Pre-fetched by the caller via fetchImageBuffer — this file never does
  // I/O itself. null/undefined when the company has no logo, or fetching
  // it failed; either way the timesheet still renders, just without one.
  logoBuffer?: Buffer | null;
}

const C = {
  ink: "#0F172A",
  body: "#334155",
  muted: "#64748B",
  faint: "#94A3B8",
  line: "#E2E8F0",
  hair: "#F1F5F9",
  head: "#F8FAFC",
  teal: "#0F766E",
  tealBg: "#F0FDFA",
  tealLine: "#99F6E4",
  amber: "#B45309",
};

const currencySymbol = (currency: string) => (currency === "USD" ? "$" : currency === "EUR" ? "€" : "£");
const money = (amount: number, currency: string) =>
  `${currencySymbol(currency)}${amount.toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const describePeriod = (start: Date | string, end: Date | string) => {
  const s = dayjs(start);
  const e = dayjs(end);
  if (s.isSame(e, "month")) {
    const fullMonth = s.date() === 1 && e.date() === e.daysInMonth();
    return fullMonth ? s.format("MMMM YYYY") : `${s.format("D")} – ${e.format("D MMMM YYYY")}`;
  }
  if (s.isSame(e, "year")) return `${s.format("D MMM")} – ${e.format("D MMM YYYY")}`;
  return `${s.format("D MMM YYYY")} – ${e.format("D MMM YYYY")}`;
};

export const generateTimesheetPdf = ({
  employeeName,
  employeeEmail,
  companyName,
  periodStart,
  periodEnd,
  rows,
  regularMinutes,
  overtimeMinutes,
  pay,
  logoBuffer,
}: GenerateTimesheetPdfOptions) => {
  // Portrait A4. bufferPages lets us stamp "Page X of Y" on every page at
  // the end. Bottom margin 0 so pdfkit never inserts a page break on its
  // own — all pagination below is done by hand against BOTTOM.
  const doc = new PDFDocument({
    size: "A4",
    layout: "portrait",
    margins: { top: 36, left: 36, right: 36, bottom: 0 },
    bufferPages: true,
  });

  const X0 = 36;
  const W = doc.page.width - 72;
  const BOTTOM = doc.page.height - 44; // leaves room for the page footer (at height - 30)
  const period = describePeriod(periodStart, periodEnd);

  const label = (text: string, x: number, y: number, width?: number) =>
    doc.font("Helvetica-Bold").fontSize(7).fillColor(C.muted)
      .text(text.toUpperCase(), x, y, { width, characterSpacing: 0.6, lineBreak: false });

  // ── Header ──────────────────────────────────────────────────────────
  doc.font("Helvetica-Bold").fontSize(22).fillColor(C.ink).text("Timesheet", X0, 36, { lineBreak: false });

  let logoRendered = false;
  if (logoBuffer) {
    try {
      doc.image(logoBuffer, X0 + W - 130, 34, { fit: [130, 30], align: "right" });
      logoRendered = true;
    } catch (err) {
      // pdfkit throws synchronously on unsupported formats — never let
      // that take the whole PDF down.
      console.error("generateTimesheetPdf: failed to render company logo:", err);
    }
  }
  if (!logoRendered) {
    doc.font("Helvetica").fontSize(9).fillColor(C.muted).text("OnClockly", X0, 44, { width: W, align: "right" });
  }

  const metaY = 72;
  const metaCols = [X0, X0 + 215, X0 + 365];
  label("Employee", metaCols[0], metaY);
  doc.font("Helvetica-Bold").fontSize(11).fillColor(C.ink).text(employeeName, metaCols[0], metaY + 11, { width: 200, lineBreak: false, ellipsis: true });
  if (employeeEmail) {
    doc.font("Helvetica").fontSize(8).fillColor(C.muted).text(employeeEmail, metaCols[0], metaY + 25, { width: 200, lineBreak: false, ellipsis: true });
  }
  label("Company", metaCols[1], metaY);
  doc.font("Helvetica-Bold").fontSize(11).fillColor(C.ink).text(companyName, metaCols[1], metaY + 11, { width: 140, lineBreak: false, ellipsis: true });
  label("Period", metaCols[2], metaY);
  doc.font("Helvetica-Bold").fontSize(11).fillColor(C.ink).text(period, metaCols[2], metaY + 11, { width: X0 + W - metaCols[2], lineBreak: false, ellipsis: true });

  // ── Summary boxes ───────────────────────────────────────────────────
  const totalMinutes = regularMinutes + overtimeMinutes;
  const declinedTotal = rows.reduce((n, r) => n + (r.declinedOvertimeMinutes ?? 0), 0);
  const pendingTotal = rows.reduce((n, r) => n + (r.pendingOvertimeMinutes ?? 0), 0);
  const symbol = currencySymbol(pay?.currency ?? "GBP");
  const rateText = describeRates(rows.map(r => Number(r.payRate)), symbol);
  const singleRate = rateText && !rateText.includes("–") ? Number(rows.find(r => r.payRate)?.payRate) : null;

  type Box = { title: string; value: string; sub: string; highlight?: boolean; valueSize?: number };
  const boxes: Box[] = [
    { title: "Total hours", value: hoursDecimal(totalMinutes), sub: `${rows.length} shift${rows.length === 1 ? "" : "s"}` },
    {
      title: "Overtime",
      value: hoursDecimal(overtimeMinutes),
      sub: [
        "approved",
        declinedTotal ? `${hoursDecimal(declinedTotal)}h declined` : null,
        pendingTotal ? `${hoursDecimal(pendingTotal)}h pending` : null,
      ].filter(Boolean).join(" · "),
    },
  ];
  if (pay) {
    const mult = pay.overtimeMultiplier;
    boxes.push({
      title: "Rates",
      value: rateText ?? "—",
      valueSize: 11,
      sub: singleRate
        ? `Overtime ×${mult} (${symbol}${(singleRate * mult).toFixed(2)}/h)`
        : `Overtime ×${mult}`,
    });
    boxes.push({
      title: "Total pay",
      value: money(pay.regularPay + pay.overtimePay, pay.currency),
      sub: "before tax & deductions",
      highlight: true,
    });
  }

  const boxY = 116;
  const boxH = 50;
  const gap = 8;
  const boxW = (W - gap * (boxes.length - 1)) / boxes.length;
  boxes.forEach((b, i) => {
    const bx = X0 + i * (boxW + gap);
    doc.roundedRect(bx, boxY, boxW, boxH, 6).lineWidth(0.8)
      .fillAndStroke(b.highlight ? C.tealBg : "#FFFFFF", b.highlight ? C.tealLine : C.line);
    label(b.title, bx + 9, boxY + 8, boxW - 18);
    doc.font("Helvetica-Bold").fontSize(b.valueSize ?? 15).fillColor(b.highlight ? C.teal : C.ink)
      .text(b.value, bx + 9, boxY + (b.valueSize ? 21 : 18), { width: boxW - 18, lineBreak: false, ellipsis: true });
    doc.font("Helvetica").fontSize(7).fillColor(C.muted)
      .text(b.sub, bx + 9, boxY + 37, { width: boxW - 18, lineBreak: false, ellipsis: true });
  });

  // ── Table ───────────────────────────────────────────────────────────
  const hasBreaks = rows.some(r => r.breakMinutes > 0);
  const fixed = { date: 64, start: 42, end: 40, brk: hasBreaks ? 40 : 0, hours: 70 };
  const jobW = W - fixed.date - fixed.start - fixed.end - fixed.brk - fixed.hours;
  const col = {
    date: X0,
    job: X0 + fixed.date,
    start: X0 + fixed.date + jobW,
    end: X0 + fixed.date + jobW + fixed.start,
    brk: X0 + fixed.date + jobW + fixed.start + fixed.end,
    hours: X0 + W - fixed.hours,
  };
  const PAD = 4.5;
  const CELL_PAD = 6;

  const drawTableHeader = (ty: number) => {
    doc.rect(X0, ty, W, 18).fill(C.head);
    doc.moveTo(X0, ty + 18).lineTo(X0 + W, ty + 18).lineWidth(0.6).strokeColor(C.line).stroke();
    const h = (t: string, x: number, w: number, align: "left" | "right" = "left") =>
      doc.font("Helvetica-Bold").fontSize(7).fillColor(C.muted)
        .text(t.toUpperCase(), x + CELL_PAD, ty + 6, { width: w - CELL_PAD * 2, align, characterSpacing: 0.5, lineBreak: false });
    h("Date", col.date, fixed.date);
    h("Job & location", col.job, jobW);
    h("Start", col.start, fixed.start, "right");
    h("End", col.end, fixed.end, "right");
    if (hasBreaks) h("Break", col.brk, fixed.brk, "right");
    h("Hours", col.hours, fixed.hours, "right");
    return ty + 18;
  };

  const newPage = (withTableHeader = true) => {
    doc.addPage({ size: "A4", layout: "portrait", margins: { top: 36, left: 36, right: 36, bottom: 0 } });
    doc.font("Helvetica-Bold").fontSize(9).fillColor(C.ink).text(employeeName, X0, 36, { continued: true })
      .font("Helvetica").fillColor(C.muted).text(`  ·  Timesheet  ·  ${period}`);
    return withTableHeader ? drawTableHeader(56) : 56;
  };

  const noteFor = (r: TimesheetPdfRow) => {
    const paid = `${hoursDecimal(r.paidMinutes)}h`;
    if (r.declinedOvertimeMinutes) return `${hoursDecimal(r.declinedOvertimeMinutes)}h overtime declined · paid ${paid}`;
    if (r.pendingOvertimeMinutes) return `${hoursDecimal(r.pendingOvertimeMinutes)}h overtime awaiting approval · not yet paid`;
    return null;
  };

  // Measure a row before drawing it, so it can grow to fit and move to the
  // next page whole instead of spilling over the following row.
  const LINE_H = 11;
  const measure = (r: TimesheetPdfRow) => {
    // Title (bold) and address (regular) share a line, so measure each in
    // its own font and work out how many lines they wrap to together.
    const avail = jobW - CELL_PAD * 2;
    doc.font("Helvetica-Bold").fontSize(8.5);
    const titleW = doc.widthOfString(r.jobTitle);
    doc.font("Helvetica").fontSize(8);
    const addrW = r.address ? doc.widthOfString(`   ${r.address}`) : 0;
    // A little slack for word-wrapping not filling each line exactly.
    const total = titleW + addrW;
    const lines = total <= avail ? 1 : Math.ceil((total * 1.06) / avail);
    let h = lines * LINE_H - 1;
    if (noteFor(r)) h += LINE_H;
    const hoursH = r.approvedOvertimeMinutes ? 2 * LINE_H - 1 : LINE_H - 1;
    return Math.max(h, hoursH) + PAD * 2;
  };

  const drawRow = (r: TimesheetPdfRow, ry: number, rh: number) => {
    const ty = ry + PAD;
    const d = dayjs(r.dayKey);
    doc.font("Helvetica-Bold").fontSize(8.5).fillColor(C.ink)
      .text(d.format("DD MMM"), col.date + CELL_PAD, ty, { continued: true, lineBreak: false })
      .font("Helvetica").fontSize(7.5).fillColor(C.faint).text(`  ${d.format("ddd")}`, { lineBreak: false });

    doc.font("Helvetica-Bold").fontSize(8.5).fillColor(C.ink)
      .text(r.jobTitle, col.job + CELL_PAD, ty, { width: jobW - CELL_PAD * 2, lineGap: 1, continued: !!r.address });
    if (r.address) {
      doc.font("Helvetica").fontSize(8).fillColor(C.muted).text(`   ${r.address}`, { lineGap: 1 });
    }
    const note = noteFor(r);
    if (note) {
      doc.font("Helvetica-Bold").fontSize(7.5).fillColor(C.amber)
        .text(note, col.job + CELL_PAD, ry + rh - PAD - 10, { width: jobW - CELL_PAD * 2, lineBreak: false, ellipsis: true });
    }

    const num = (t: string, x: number, w: number, color = C.body, bold = false) =>
      doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(8.5).fillColor(color)
        .text(t, x + CELL_PAD, ty, { width: w - CELL_PAD * 2, align: "right", lineBreak: false });
    num(r.startTime, col.start, fixed.start);
    num(r.endTime, col.end, fixed.end);
    if (hasBreaks) num(r.breakMinutes ? `${r.breakMinutes}m` : "—", col.brk, fixed.brk, r.breakMinutes ? C.body : C.faint);
    num(hoursDecimal(r.paidMinutes), col.hours, fixed.hours, C.ink, true);
    if (r.approvedOvertimeMinutes) {
      doc.font("Helvetica-Bold").fontSize(7).fillColor(C.teal)
        .text(`incl. ${hoursDecimal(r.approvedOvertimeMinutes)} OT`, col.hours + CELL_PAD, ty + 11, { width: fixed.hours - CELL_PAD * 2, align: "right", lineBreak: false });
    }
    doc.moveTo(X0, ry + rh).lineTo(X0 + W, ry + rh).lineWidth(0.5).strokeColor(C.hair).stroke();
  };

  const WEEK_H = 14;
  const drawWeek = (weekStart: string, minutes: number, wy: number) => {
    doc.rect(X0, wy, W, WEEK_H).fill(C.head);
    doc.moveTo(X0, wy + WEEK_H).lineTo(X0 + W, wy + WEEK_H).lineWidth(0.5).strokeColor(C.line).stroke();
    doc.font("Helvetica-Bold").fontSize(7).fillColor(C.muted)
      .text(`Week of ${dayjs(weekStart).format("D MMM")}`, X0 + CELL_PAD, wy + 4, { lineBreak: false })
      .text(hoursDecimal(minutes), col.hours + CELL_PAD, wy + 4, { width: fixed.hours - CELL_PAD * 2, align: "right", lineBreak: false });
    return wy + WEEK_H;
  };

  let y = drawTableHeader(boxY + boxH + 14);

  // Week subtotals only when the period is long enough to need them.
  const showWeeks = dayjs(periodEnd).diff(dayjs(periodStart), "day") >= 7;
  const weekTotals = new Map<string, number>();
  rows.forEach(r => {
    const wk = weekStartOf(r.dayKey);
    weekTotals.set(wk, (weekTotals.get(wk) ?? 0) + r.paidMinutes);
  });

  let currentWeek: string | null = null;
  rows.forEach(r => {
    const rh = measure(r);
    const wk = weekStartOf(r.dayKey);
    const needsWeek = showWeeks && wk !== currentWeek;
    // Keep a week heading together with its first row.
    if (y + rh + (needsWeek ? WEEK_H : 0) > BOTTOM) y = newPage();
    if (needsWeek) {
      y = drawWeek(wk, weekTotals.get(wk) ?? 0, y);
      currentWeek = wk;
    }
    drawRow(r, y, rh);
    y += rh;
  });

  if (rows.length === 0) {
    doc.font("Helvetica").fontSize(9).fillColor(C.faint)
      .text("No completed shifts were found for this period.", X0 + CELL_PAD, y + 14);
    y += 40;
  }

  // ── Notes + totals ──────────────────────────────────────────────────
  // Hours and pay totals side by side, so the block stays short and
  // usually fits under the table on the same page.
  const totalsH = 62;
  if (y + 14 + totalsH > BOTTOM) y = newPage(false);
  y += 14;

  const blockW = 150;
  const blocks = pay ? 2 : 1;
  const blocksX = X0 + W - blocks * blockW - (blocks - 1) * 20;
  doc.font("Helvetica").fontSize(7.5).fillColor(C.muted).text(
    "Hours are worked out from exact clock-in and clock-out times, so they can differ by a minute or two from the times shown. " +
      "Overtime counts only when a manager approves it; declined overtime is paid at the scheduled hours.",
    X0, y, { width: blocksX - X0 - 24, lineGap: 2 }
  );

  const totalsBlock = (bx: number, lines: [string, string][], total: [string, string]) => {
    let ty = y;
    lines.forEach(([name, value]) => {
      doc.font("Helvetica").fontSize(8.5).fillColor(C.muted).text(name, bx, ty, { width: blockW / 2, lineBreak: false });
      doc.font("Helvetica").fontSize(8.5).fillColor(C.ink).text(value, bx + blockW / 2, ty, { width: blockW / 2, align: "right", lineBreak: false });
      ty += 14;
    });
    doc.moveTo(bx, ty + 1).lineTo(bx + blockW, ty + 1).lineWidth(0.6).strokeColor("#CBD5E1").stroke();
    ty += 7;
    doc.font("Helvetica-Bold").fontSize(10).fillColor(C.ink).text(total[0], bx, ty, { width: blockW / 2, lineBreak: false });
    doc.font("Helvetica-Bold").fontSize(10).fillColor(C.ink).text(total[1], bx + blockW / 2, ty, { width: blockW / 2, align: "right", lineBreak: false });
  };

  totalsBlock(
    blocksX,
    [["Regular hours", hoursDecimal(regularMinutes)], ["Overtime", hoursDecimal(overtimeMinutes)]],
    ["Total hours", hoursDecimal(totalMinutes)]
  );
  if (pay) {
    totalsBlock(
      blocksX + blockW + 20,
      [["Regular pay", money(pay.regularPay, pay.currency)], ["Overtime pay", money(pay.overtimePay, pay.currency)]],
      ["Total pay", money(pay.regularPay + pay.overtimePay, pay.currency)]
    );
  }

  // ── Footer on every page ────────────────────────────────────────────
  const generated = `Generated ${dayjs().format("D MMM YYYY HH:mm")} by OnClockly`;
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    const fy = doc.page.height - 30;
    doc.font("Helvetica").fontSize(7).fillColor(C.faint)
      .text(`${employeeName}  ·  ${period}  ·  ${generated}`, X0, fy, { width: W - 80, lineBreak: false, ellipsis: true })
      .text(`Page ${i - range.start + 1} of ${range.count}`, X0 + W - 80, fy, { width: 80, align: "right", lineBreak: false });
  }

  return doc;
};
