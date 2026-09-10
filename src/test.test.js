import { sendMail } from "./utils/sendMailsUtils.js";

await sendMail({
  to: "bateemma14@gmail.com",
  subject: "Test from INPRN",
  text: "Plain text version",
  html: "<h1>It works</h1>",
});