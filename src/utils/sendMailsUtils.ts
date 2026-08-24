import { Resend } from "resend";

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