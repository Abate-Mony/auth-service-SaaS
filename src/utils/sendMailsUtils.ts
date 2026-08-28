import dayjs from "dayjs";
import { Resend } from "resend";
import { WorkerJobEmailParams } from "./interfaces.js";
import { EMAIL_WORTHY_EVENTS } from "./constant.js";

let _resend: Resend | null = null;

function getResend() {
    if (!_resend) {
        const apiKey = process.env.RESEND_API_KEY;

        if (!apiKey) {
            throw new Error("RESEND_API_KEY is not configured");
        }

        _resend = new Resend(apiKey);
    }

    return _resend;
}

export async function sendMail(opts: {
    to: string;
    subject: string;
    text: string;
    html: string;
}) {
    const resend = getResend();

    const { data, error } = await resend.emails.send({
        from: `work.wrk <${process.env.EMAIL_FROM}>`,
        to: opts.to,
        subject: opts.subject,
        text: opts.text,
        html: opts.html,
    });

    if (error) {
        console.error("sendMail failed:", opts.subject, error);
        throw new Error(error.message);
    }

    console.log("Email sent:", data?.id);

    return data;
}
export async function sendWorkerJobStatusEmail({
  type,
  adminEmail,
  worker,
  job,
  reason,
  minutesLate,
  distanceMeters,
  overtimeMinutes,
}: WorkerJobEmailParams) {

  // ─────────────────────────────────────────────
  // Prevent noisy routine emails
  // ─────────────────────────────────────────────
  if (!EMAIL_WORTHY_EVENTS.has(type)) {
    return;
  }

  const fullname = worker.fullname;

  const actionTime = dayjs().format("DD MMM YYYY [at] HH:mm");

  const jobDate = dayjs(job.date).format(
    "dddd, DD MMMM YYYY"
  );

  const jobUrl = `${process.env.CLIENT_URL}/jobs/${job._id}`;

  // ─────────────────────────────────────────────
  // Email configuration
  // ─────────────────────────────────────────────

  const configs = {
    "reject-job": {
      subject: `Shift declined: ${job.title}`,

      heading: "A worker declined a shift",

      message:
        `${fullname} declined "${job.title}" at ${actionTime}. ` +
        `You may need to assign another worker.`,

      action: "View job & assign worker",
    },

    "late-start": {
      subject: `Late check-in: ${fullname}`,

      heading: "Worker checked in late",

      message:
        `${fullname} checked in ${minutesLate ?? 0} minutes late ` +
        `for "${job.title}".`,

      action: "View job",
    },

    "geofence-warning": {
      subject: `Location warning: ${fullname}`,

      heading: "Worker checked in outside the job location",

      message:
        `${fullname} attempted to check in for "${job.title}" ` +
        `${distanceMeters != null
          ? `approximately ${distanceMeters}m from the job location.`
          : "outside the expected job location."
        }`,

      action: "Review check-in",
    },

    "overtime-review": {
      subject: `Overtime needs review: ${fullname}`,

      heading: "A shift ran over and needs your approval",

      message:
        `${fullname} clocked out ${overtimeMinutes ?? 0} minutes past the scheduled ` +
        `end time for "${job.title}". This extra time won't be paid until you approve it.`,

      action: "Review overtime",
    },

    // These don't send email because of EMAIL_WORTHY_EVENTS,
    // but keeping them here makes the type complete.
    "accept-job": null,
    "start-job": null,
    "complete-job": null,
  } as const;

  const config = configs[type];

  if (!config) return;

  // ─────────────────────────────────────────────
  // Optional information
  // ─────────────────────────────────────────────

  const reasonRow =
    type === "reject-job" && reason
      ? `
        <tr>
          <td style="${labelStyle}">
            Reason
          </td>

          <td style="${valueStyle}">
            ${reason}
          </td>
        </tr>
      `
      : "";

  const lateRow =
    type === "late-start" && minutesLate != null
      ? `
        <tr>
          <td style="${labelStyle}">
            Late by
          </td>

          <td style="${valueStyle}">
            ${minutesLate} minutes
          </td>
        </tr>
      `
      : "";

  const distanceRow =
    type === "geofence-warning" && distanceMeters != null
      ? `
        <tr>
          <td style="${labelStyle}">
            Distance from site
          </td>

          <td style="${valueStyle}">
            ${distanceMeters} metres
          </td>
        </tr>
      `
      : "";

  const overtimeRow =
    type === "overtime-review" && overtimeMinutes != null
      ? `
        <tr>
          <td style="${labelStyle}">
            Extra time
          </td>

          <td style="${valueStyle}">
            ${overtimeMinutes} minutes
          </td>
        </tr>
      `
      : "";

  // ─────────────────────────────────────────────
  // HTML
  // ─────────────────────────────────────────────

  const html = `
    <div style="
      background:#f8fafc;
      padding:32px 16px;
      font-family:Arial,Helvetica,sans-serif;
    ">

      <div style="
        max-width:600px;
        margin:0 auto;
        background:#ffffff;
        border:1px solid #e2e8f0;
        border-radius:12px;
        overflow:hidden;
      ">

        <!-- Header -->

        <div style="
          padding:24px 28px;
          border-bottom:1px solid #e2e8f0;
        ">

          <div style="
            font-size:13px;
            font-weight:600;
            color:#64748b;
            margin-bottom:8px;
          ">
            work.wrk
          </div>

          <h1 style="
            margin:0;
            font-size:20px;
            color:#0f172a;
          ">
            ${config.heading}
          </h1>

        </div>


        <!-- Content -->

        <div style="padding:28px;">

          <p style="
            margin:0 0 24px;
            color:#475569;
            font-size:15px;
            line-height:1.6;
          ">
            ${config.message}
          </p>


          <!-- Job information -->

          <table style="
            width:100%;
            border-collapse:collapse;
            background:#f8fafc;
            border-radius:10px;
          ">

            <tr>
              <td style="${labelStyle}">
                Worker
              </td>

              <td style="${valueStyle}">
                ${fullname}
              </td>
            </tr>

            <tr>
              <td style="${labelStyle}">
                Job
              </td>

              <td style="${valueStyle}">
                ${job.title}
              </td>
            </tr>

            <tr>
              <td style="${labelStyle}">
                Date
              </td>

              <td style="${valueStyle}">
                ${jobDate}
              </td>
            </tr>

            <tr>
              <td style="${labelStyle}">
                Shift
              </td>

              <td style="${valueStyle}">
                ${job.startTime} – ${job.endTime}
              </td>
            </tr>

            ${
              job.location
                ? `
                  <tr>
                    <td style="${labelStyle}">
                      Location
                    </td>

                    <td style="${valueStyle}">
                      ${job.location}
                    </td>
                  </tr>
                `
                : ""
            }

            ${reasonRow}

            ${lateRow}

            ${distanceRow}

            ${overtimeRow}

          </table>


          <!-- CTA -->

          <div style="margin-top:28px;">

            <a
              href="${jobUrl}"
              style="
                display:inline-block;
                background:#0f172a;
                color:#ffffff;
                text-decoration:none;
                padding:12px 18px;
                border-radius:8px;
                font-size:14px;
                font-weight:600;
              "
            >
              ${config.action}
            </a>

          </div>


          <p style="
            margin:28px 0 0;
            color:#94a3b8;
            font-size:12px;
          ">
            This notification was sent because this shift may require your attention.
          </p>

        </div>

      </div>

    </div>
  `;

  // ─────────────────────────────────────────────
  // Plain text fallback
  // ─────────────────────────────────────────────

  const text = `
${config.heading}

${config.message}

Worker: ${fullname}
Job: ${job.title}
Date: ${jobDate}
Shift: ${job.startTime} - ${job.endTime}
${job.location ? `Location: ${job.location}` : ""}
${reason ? `Reason: ${reason}` : ""}
${minutesLate != null ? `Late by: ${minutesLate} minutes` : ""}
${distanceMeters != null ? `Distance from site: ${distanceMeters}m` : ""}
${type === "overtime-review" && overtimeMinutes != null ? `Extra time: ${overtimeMinutes} minutes` : ""}

View job:
${jobUrl}
  `.trim();

  await sendMail({
    to: adminEmail,
    subject: config.subject,
    text,
    html,
  });
}


// ─────────────────────────────────────────────
// Shared email styles
// ─────────────────────────────────────────────

const labelStyle = `
  padding:12px 16px;
  color:#64748b;
  font-size:13px;
  border-bottom:1px solid #e2e8f0;
  width:35%;
`;

const valueStyle = `
  padding:12px 16px;
  color:#0f172a;
  font-size:14px;
  font-weight:500;
  border-bottom:1px solid #e2e8f0;
`;