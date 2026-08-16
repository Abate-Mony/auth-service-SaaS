import nodemailer from "nodemailer";

let _transporter: nodemailer.Transporter | null = null;

// Built on first send rather than at import time — otherwise the transporter
// is constructed before dotenv loads and permanently captures undefined
// credentials (which is why it fell back to localhost:587).
function getTransporter() {
  if (!_transporter) {
    _transporter = nodemailer.createTransport({
      service: "gmail",
      auth: {
        user: process.env.user,
        pass: process.env.pass,
      },
    });
  }
  return _transporter;
}

export async function sendMail(opts: {
  to: string;
  subject: string;
  text: string;
  html: string;
}) {
  const from = {
    name: "work.wrk",
    address: process.env.user as string,
  };

  try {
    await getTransporter().sendMail({ from, ...opts });
  } catch (err) {
    console.error("sendMail failed:", opts.subject, err);
  }
}
export async function sendMailMany(
  messages: { to: string; subject: string; text: string; html: string }[]
) {
  // allSettled so one bad address doesn't stop the rest
  const results = await Promise.allSettled(messages.map(m => sendMail(m)));

  const failed = results.filter(r => r.status === "rejected").length;
  if (failed) console.error(`sendMailMany: ${failed}/${messages.length} failed`);
}