// utils/mailTemplates.ts
import dayjs from "./dayjsSetup.js";
import { TZ } from "./dates.js";
import { sendMail } from "./sendMailsUtils.js";

const BRAND = "#1E3A5F";
const ACCENT = "#3B82F6";

/** Shared shell — every email gets the same header, container and footer. */
function layout({ heading, body }: { heading: string; body: string }) {
  return `
  <div style="background:#F8FAFC;padding:32px 16px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;">
    <div style="max-width:520px;margin:0 auto;background:#ffffff;border:1px solid #E2E8F0;border-radius:16px;overflow:hidden;">

      <div style="padding:20px 28px;border-bottom:1px solid #F1F5F9;">
        <span style="font-size:17px;font-weight:600;color:#0F172A;letter-spacing:-0.3px;">
          work<span style="color:${ACCENT};">.wrk</span>
        </span>
      </div>

      <div style="padding:28px;">
        <h1 style="margin:0 0 16px;font-size:20px;font-weight:700;color:#0F172A;">${heading}</h1>
        ${body}
      </div>

      <div style="padding:18px 28px;background:#F8FAFC;border-top:1px solid #F1F5F9;">
        <p style="margin:0;font-size:12px;color:#94A3B8;">
          You're receiving this because you're on a team using work.wrk.
        </p>
      </div>

    </div>
  </div>`;
}

function button(href: string, label: string) {
  return `<a href="${href}" style="display:inline-block;background:${BRAND};color:#ffffff;padding:12px 24px;border-radius:12px;text-decoration:none;font-size:14px;font-weight:700;margin:20px 0;">${label}</a>`;
}

function detailRow(label: string, value: string) {
  return `
  <tr>
    <td style="padding:8px 0;font-size:13px;color:#94A3B8;width:110px;">${label}</td>
    <td style="padding:8px 0;font-size:14px;color:#0F172A;font-weight:600;">${value}</td>
  </tr>`;
}

interface ShiftJob {
  _id: string;
  title: string;
  location: string;
  address?: string;
  date: Date | string;
  startTime: string;
  endTime: string;
  minutes: number;
}

export async function sendShiftAssigned({
  worker,
  job,
}: {
  worker: { email: string; fullname: string };
  job: ShiftJob;
}) {
  const when = dayjs(job.date).tz(TZ).format("dddd D MMMM");
  const hours = Math.floor(job.minutes / 60);
  const mins = job.minutes % 60;
  const duration = mins ? `${hours}h ${mins}m` : `${hours}h`;
  const link = `${process.env.CLIENT_URL}/worker/jobs/${job._id}`;
  const firstName = worker.fullname.split(" ")[0];

  const body = `
    <p style="margin:0 0 20px;font-size:15px;line-height:1.6;color:#475569;">
      Hi ${firstName}, you've been assigned a new shift. Open the app to accept or decline it.
    </p>

    <table style="width:100%;border-collapse:collapse;background:#F8FAFC;border-radius:12px;padding:4px 16px;">
      ${detailRow("Job", job.title)}
      ${detailRow("Date", when)}
      ${detailRow("Time", `${job.startTime} – ${job.endTime} (${duration})`)}
      ${detailRow("Location", job.address ? `${job.location}, ${job.address}` : job.location)}
    </table>

    ${button(link, "Accept or decline")}

    <p style="margin:0;font-size:13px;color:#94A3B8;">
      Please respond as soon as you can so your manager knows whether the shift is covered.
    </p>`;

  await sendMail({
    to: worker.email,
    subject: `New shift: ${job.title} — ${dayjs(job.date).tz(TZ).format("ddd D MMM")}`,
    text:
      `Hi ${firstName},\n\n` +
      `You've been assigned a new shift.\n\n` +
      `Job: ${job.title}\n` +
      `Date: ${when}\n` +
      `Time: ${job.startTime} – ${job.endTime} (${duration})\n` +
      `Location: ${job.location}\n\n` +
      `Accept or decline: ${link}`,
    html: layout({ heading: "You've got a new shift", body }),
  });
}

/** Recurring schedules assign many occurrences at once — one summary
 *  rather than an email per generated date. */
export async function sendRecurringShiftAssigned({
  worker,
  job,
  occurrenceCount,
  firstDate,
  lastDate,
  daysLabel,
}: {
  worker: { email: string; fullname: string };
  job: ShiftJob;
  occurrenceCount: number;
  firstDate: Date | string;
  lastDate: Date | string;
  daysLabel: string;
}) {
  const link = `${process.env.CLIENT_URL}/worker/jobs`;
  const firstName = worker.fullname.split(" ")[0];
  const range = `${dayjs(firstDate).tz(TZ).format("D MMM")} – ${dayjs(lastDate).tz(TZ).format("D MMM")}`;

  const body = `
    <p style="margin:0 0 20px;font-size:15px;line-height:1.6;color:#475569;">
      Hi ${firstName}, you've been added to a recurring shift. That's
      <strong>${occurrenceCount} shifts</strong> in your schedule — open the app to review them.
    </p>

    <table style="width:100%;border-collapse:collapse;background:#F8FAFC;border-radius:12px;padding:4px 16px;">
      ${detailRow("Job", job.title)}
      ${detailRow("Repeats", daysLabel)}
      ${detailRow("Time", `${job.startTime} – ${job.endTime}`)}
      ${detailRow("Between", range)}
      ${detailRow("Location", job.location)}
    </table>

    ${button(link, "View my shifts")}`;

  await sendMail({
    to: worker.email,
    subject: `You've been added to ${job.title} (${occurrenceCount} shifts)`,
    text:
      `Hi ${firstName},\n\n` +
      `You've been added to a recurring shift — ${occurrenceCount} shifts in total.\n\n` +
      `Job: ${job.title}\n` +
      `Repeats: ${daysLabel}\n` +
      `Time: ${job.startTime} – ${job.endTime}\n` +
      `Between: ${range}\n` +
      `Location: ${job.location}\n\n` +
      `View your shifts: ${link}`,
    html: layout({ heading: "You've been added to a recurring shift", body }),
  });
}
/** Manager-facing counterpart to sendRecurringShiftAssigned — a worker
 *  responding to a whole series at once (bulk accept/decline) gets the
 *  manager one summary too, not one email per shift. */
export async function sendRecurringSeriesResponse({
  manager,
  worker,
  job,
  recurringJobId,
  type,
  count,
  firstDate,
  lastDate,
}: {
  manager: { email: string };
  worker: { fullname: string };
  job: { title: string };
  recurringJobId: string;
  type: "accepted" | "declined";
  count: number;
  firstDate: Date | string;
  lastDate: Date | string;
}) {
  const link = `${process.env.CLIENT_URL}/jobs/recurring/recurring-job-detail/${recurringJobId}`;
  const range = `${dayjs(firstDate).tz(TZ).format("D MMM")} – ${dayjs(lastDate).tz(TZ).format("D MMM")}`;
  const verb = type === "accepted" ? "accepted" : "declined";

  const body = `
    <p style="margin:0 0 20px;font-size:15px;line-height:1.6;color:#475569;">
      ${worker.fullname} ${verb} <strong>${count} shift${count === 1 ? "" : "s"}</strong> in one go on the recurring schedule below.
      ${type === "declined" ? "You may need to cover these." : ""}
    </p>

    <table style="width:100%;border-collapse:collapse;background:#F8FAFC;border-radius:12px;padding:4px 16px;">
      ${detailRow("Job", job.title)}
      ${detailRow("Shifts", `${count} ${verb}`)}
      ${detailRow("Between", range)}
    </table>

    ${button(link, "View schedule")}`;

  await sendMail({
    to: manager.email,
    subject: `${worker.fullname} ${verb} ${count} shift${count === 1 ? "" : "s"} — ${job.title}`,
    text:
      `${worker.fullname} ${verb} ${count} shift${count === 1 ? "" : "s"} in one go.\n\n` +
      `Job: ${job.title}\n` +
      `Between: ${range}\n\n` +
      `View schedule: ${link}`,
    html: layout({ heading: `${count} shift${count === 1 ? "" : "s"} ${verb}`, body }),
  });
}

export async function sendShiftReminder({
  worker,
  job,
}: {
  worker: { email: string; fullname: string };
  job: ShiftJob;
}) {
  const firstName = worker.fullname.split(" ")[0];
  const when = dayjs(job.date).tz(TZ).format("dddd D MMMM");
  const link = `${process.env.CLIENT_URL}/worker/jobs/${job._id}`;

  const body = `
    <p style="margin:0 0 20px;font-size:15px;line-height:1.6;color:#475569;">
      Hi ${firstName}, your shift starts in about 30 minutes.
    </p>

    <table style="width:100%;border-collapse:collapse;background:#F8FAFC;border-radius:12px;padding:4px 16px;">
      ${detailRow("Job", job.title)}
      ${detailRow("Date", when)}
      ${detailRow("Time", `${job.startTime} – ${job.endTime}`)}
      ${detailRow("Location", job.address ? `${job.location}, ${job.address}` : job.location)}
    </table>

    ${button(link, "View shift")}`;

  await sendMail({
    to: worker.email,
    subject: `Starting soon: ${job.title} at ${job.startTime}`,
    text:
      `Hi ${firstName},\n\n` +
      `Your shift starts in about 30 minutes.\n\n` +
      `Job: ${job.title}\n` +
      `Date: ${when}\n` +
      `Time: ${job.startTime} – ${job.endTime}\n` +
      `Location: ${job.location}\n\n` +
      `View shift: ${link}`,
    html: layout({ heading: "Your shift starts soon", body }),
  });
}

export async function sendInvitationEmail({
  email,
  fullname,
  companyName,
  inviterName,
  role,
  invitationToken,
}: {
  email: string;
  fullname?: string;
  companyName: string;
  inviterName: string;
  role: "worker" | "manager";
  invitationToken: string;
}) {
  const greeting = fullname ? fullname.split(" ")[0] : "there";
  const roleLabel = role === "manager" ? "Manager" : "Worker";
  const link = `${process.env.CLIENT_URL}/invite/accept?token=${encodeURIComponent(invitationToken)}`;

  const body = `
    <p style="margin:0 0 20px;font-size:15px;line-height:1.6;color:#475569;">
      Hi ${greeting}, ${inviterName} invited you to join <strong>${companyName}</strong>
      as a ${roleLabel}.
    </p>

    ${button(link, "Accept invitation")}

    <p style="margin:0;font-size:13px;color:#94A3B8;">
      This invitation expires in 7 days. If you weren't expecting this, you can ignore this email.
    </p>`;

  await sendMail({
    to: email,
    subject: `You've been invited to join ${companyName}`,
    text:
      `Hi ${greeting},\n\n` +
      `${inviterName} invited you to join ${companyName} as a ${roleLabel}.\n\n` +
      `Accept invitation: ${link}\n\n` +
      `This invitation expires in 7 days. If you weren't expecting this, you can ignore this email.`,
    html: layout({ heading: `You're invited to join ${companyName}`, body }),
    companyName,
  });
}

export async function sendVerificationEmail({
  email,
  fullname,
  verificationToken,
}: {
  email: string;
  fullname: string;
  verificationToken: string;
}) {
  const firstName = fullname.split(" ")[0];
  const link = `${process.env.CLIENT_URL}/auth/verify-email?token=${verificationToken}`;

  const body = `
    <p style="margin:0 0 20px;font-size:15px;line-height:1.6;color:#475569;">
      Hi ${firstName}, confirm your email address to finish setting up your work.wrk account.
    </p>

    ${button(link, "Verify email")}

    <p style="margin:0;font-size:13px;color:#94A3B8;">
      This link expires in 24 hours. If you didn't create this account, you can ignore this email.
    </p>`;

  await sendMail({
    to: email,
    subject: "Verify your email address",
    text:
      `Hi ${firstName},\n\n` +
      `Confirm your email address to finish setting up your work.wrk account.\n\n` +
      `Verify email: ${link}\n\n` +
      `This link expires in 24 hours. If you didn't create this account, you can ignore this email.`,
    html: layout({ heading: "Verify your email address", body }),
  });
}

export async function sendPasswordResetEmail({
  email,
  fullname,
  resetToken,
}: {
  email: string;
  fullname: string;
  resetToken: string;
}) {
  const firstName = fullname.split(" ")[0];
  const link = `${process.env.CLIENT_URL}/auth/reset-password?token=${resetToken}`;

  const body = `
    <p style="margin:0 0 20px;font-size:15px;line-height:1.6;color:#475569;">
      Hi ${firstName}, we got a request to reset your work.wrk password.
    </p>

    ${button(link, "Reset password")}

    <p style="margin:0;font-size:13px;color:#94A3B8;">
      This link expires in 30 minutes. If you didn't request this, you can ignore this email —
      your password won't change.
    </p>`;

  await sendMail({
    to: email,
    subject: "Reset your password",
    text:
      `Hi ${firstName},\n\n` +
      `We got a request to reset your work.wrk password.\n\n` +
      `Reset password: ${link}\n\n` +
      `This link expires in 30 minutes. If you didn't request this, you can ignore this email.`,
    html: layout({ heading: "Reset your password", body }),
  });
}

export const sendWorkerInvite = async ({
  email, fullname, companyName, inviteToken,
}: { email: string; fullname: string; companyName: string; inviteToken: string }) => {
  const link = `${process.env.CLIENT_URL}/auth/set-password?token=${inviteToken}`;

  await sendMail({
    to: email,
    subject: `You've been added to ${companyName} on work.wrk`,
    text: `Hi ${fullname}, ${companyName} has added you to work.wrk. Set your password: ${link}`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto; color: #0F172A;">
        <h2 style="color: #1E3A5F;">Welcome to work.wrk</h2>
        <p>Hi ${fullname},</p>
        <p><strong>${companyName}</strong> has added you to work.wrk, where you'll see your shifts, accept or decline jobs, and clock in and out.</p>
        <a href="${link}" style="display: inline-block; background: #1E3A5F; color: #fff; padding: 12px 24px; border-radius: 12px; text-decoration: none; font-weight: bold; margin: 20px 0;">Set your password</a>
        <p style="font-size: 13px; color: #64748B;">This link expires in 7 days.</p>
      </div>
    `,
  });
};