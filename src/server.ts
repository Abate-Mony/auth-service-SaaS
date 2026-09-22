// @ts-ignore
import * as dotenv from "dotenv";
dotenv.config({ path: "./.env" });
import dns from "node:dns";
// Some hosts (e.g. DigitalOcean droplets) have no outbound IPv6 route.
// Without this, any outbound call to a host whose DNS returns an IPv6
// address first (Gmail SMTP, Google OAuth, Cloudinary, ...) fails with
// ENETUNREACH instead of falling back to IPv4.
dns.setDefaultResultOrder("ipv4first");
import "express-async-errors";
import express from "express";
import path, { dirname } from "path";
import { fileURLToPath } from "url";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import { v2 as cloudinary } from 'cloudinary';
import authRouter from "./routes/authRouter.js";
import userRouter from "./routes/userRouter.js";
import Database from "./db/connections.js";
import errorHandlerMiddleware from "./middleware/errorHandlerMiddleware.js";
import calendarRouter from "./routes/calendarRouter.js"
import cors from "cors";
import { authenticateUser } from "./middleware/authMiddleware.js";
import { loadRestriction } from "./middleware/restrictionMiddleware.js";
import { enforceCompanyStatus } from "./middleware/companyStatusMiddleware.js";
import platformRouter from "./routes/platformRouter.js";
import jobRouter from "./routes/jobRouter.js";
import aiRouter from "./routes/aiRouter.js";
import documentRouter from "./routes/documentRouter.js";
import workerRouter from "./routes/workerRouter.js"
import activityLogRouter from "./routes/activity_logs_router.js"
import companyRouter from "./routes/companyRouter.js"
import externalRouter from "./routes/externalRouter.js"
import { getPlanCatalog } from "./controllers/companyController.js"
import cron from "node-cron";
import { runDailyOccurrenceGeneration } from "./utils/runDailyOccurrenceGeneration.js";
import { sendUpcomingShiftReminders } from "./utils/sendUpcomingShiftReminders.js";
import { autoCloseAbandonedShifts } from "./utils/autoCloseAbandonedShifts.js";
import { sendOverduePaymentReminders } from "./utils/sendPaymentReminders.js";
import { generateRecurringInvoices } from "./services/invoice/recurringInvoiceGenerator.js";
import notificationPreferenceRouter
  from "./routes/notificationPreferenceRouter.js";
  import timesheetRouter from "./routes/timesheetRouter.js";
  import invitationRouter from "./routes/invitationRouter.js";
  import recurringJobRouter from "./routes/recurringJobRouter.js";
  import clientRouter from "./routes/clientRouter.js";
  import siteRouter from "./routes/siteRouter.js";
  import invoiceRouter from "./routes/invoiceRouter.js";
  import invoiceTemplateRouter from "./routes/invoiceTemplateRouter.js";
  import quoteRouter from "./routes/quoteRouter.js";
  import userRestrictionRouter from "./routes/userRestrictionRouter.js";
  import analyticsRouter from "./routes/analyticsRouter.js";
  import reportRouter from "./routes/reportRouter.js";
  import notificationRouter from "./routes/notificationRouter.js";
const app = express();
// crossOriginResourcePolicy defaults to "same-origin", which would block the
// frontend (a different subdomain) from loading anything under /public —
// contentSecurityPolicy is also off since this is a pure JSON API with no
// HTML views of its own to protect.
app.use(helmet({
  crossOriginResourcePolicy: { policy: "cross-origin" },
  contentSecurityPolicy: false,
}));
app.use(express.json());

const __dirname = dirname(fileURLToPath(import.meta.url));
const filepath = path.resolve(__dirname, "../public/");

// The web app (cookie-based session) is the only client CORS needs to gate —
// the mobile app authenticates with a Bearer header and sends no Origin, so
// it's unaffected by this. Reflecting any origin (the old `origin: true`)
// would let any website make credentialed requests using a logged-in
// visitor's cookies.
const ALLOWED_ORIGINS = [
  "https://timeshift.inprn.com",
  "https://localhost:5173",
  "http://localhost:5173",
  "http://192.168.1.81:5000"
];

app.use(
  cors({
    origin: ALLOWED_ORIGINS,
    credentials: true,
  })
);
cloudinary.config({
  cloud_name: process.env.cloudinary_name,
  api_key: process.env.cloudinary_api_key,
  api_secret: process.env.cloudinary_api_secret,
});

// app.use(cookieParser())
app.use(cookieParser());
app.use(
  "/public",
  express.static(
    // path.resolve(__dirname, "./dist/public/index.js")
    filepath
  )
);
// DONE WITH AUTH DOCUMENTATION ON POSTMAN
app.use(`/api/v1/auth`, authRouter);
// Public — the same static plan catalog every visitor sees, no company/user
// data involved. Exists so the public marketing page's pricing section can
// show real, enforced numbers (see utils/constant.ts's own note on this)
// instead of a second hand-maintained copy of them.
app.get("/api/v1/plans", getPlanCatalog);
// DONE WITH USERS DOCUMENTATION ON POSTMAN
app.use(`/api/v1/users`,
  authenticateUser,
  loadRestriction, enforceCompanyStatus,
  userRouter);
// DONE WITH USERS DOCUMENTATION ON POSTMAN
app.use("/api/v1/jobs", authenticateUser, loadRestriction, enforceCompanyStatus, jobRouter);
// DONE WITH WORKERS DOCUMENTATION ON POSTMAN
app.use("/api/v1/workers",
  authenticateUser,
  loadRestriction, enforceCompanyStatus,
  workerRouter
)
app.use(
  "/api/v1/notification-preferences",
  authenticateUser,
  loadRestriction, enforceCompanyStatus,
  notificationPreferenceRouter
);
app.use("/api/v1/activity-logs", authenticateUser, loadRestriction, enforceCompanyStatus, activityLogRouter);
app.use("/api/v1/companies", authenticateUser, loadRestriction, enforceCompanyStatus, companyRouter);
app.use(
  "/api/v1/timesheets",
  authenticateUser,
  loadRestriction, enforceCompanyStatus,
  timesheetRouter
);
app.use("/api/v1/calendar", authenticateUser, loadRestriction, enforceCompanyStatus, calendarRouter)
// Not wrapped in authenticateUser at this level — validate/accept are
// public (the recipient isn't logged in yet); the router applies
// authenticateUser itself on the routes that actually need it.
app.use("/api/v1/invitations", invitationRouter)
app.use("/api/v1/recurring-jobs", authenticateUser, loadRestriction, enforceCompanyStatus, recurringJobRouter)
app.use("/api/v1/clients", authenticateUser, loadRestriction, enforceCompanyStatus, clientRouter)
app.use("/api/v1/sites", authenticateUser, loadRestriction, enforceCompanyStatus, siteRouter)
app.use("/api/v1/invoices", authenticateUser, loadRestriction, enforceCompanyStatus, invoiceRouter)
app.use("/api/v1/invoice-templates", authenticateUser, loadRestriction, enforceCompanyStatus, invoiceTemplateRouter)
// Not wrapped in authenticateUser at this level — the public quote
// view/respond routes need to work for a client with no session, same
// reasoning as invitationRouter above. Authenticated quote routes apply
// authenticateUser/authorizePermissions themselves inside quoteRouter.
app.use("/api/v1/quotes", quoteRouter)
// Applies authenticateUser and loadRestriction itself (see userRestrictionRouter)
// since GET /me and POST /me/appeal must stay reachable at every access level.
app.use("/api/v1/restrictions", userRestrictionRouter)
app.use("/api/v1/analytics", authenticateUser, loadRestriction, enforceCompanyStatus, analyticsRouter)
app.use("/api/v1/reports", authenticateUser, loadRestriction, enforceCompanyStatus, reportRouter)
app.use("/api/v1/notifications", authenticateUser, loadRestriction, enforceCompanyStatus, notificationRouter)
app.use("/api/v1/ai", authenticateUser, loadRestriction, enforceCompanyStatus, aiRouter)
app.use("/api/v1/documents", authenticateUser, loadRestriction, enforceCompanyStatus, documentRouter)
// API-key authenticated, not a user session — see externalRouter.ts's own
// header for why this is mounted separately from every router above.
app.use("/api/v1/external", externalRouter)
// Deliberately NOT behind loadRestriction/enforceCompanyStatus — those gate
// tenant access to one company, and a platform admin isn't necessarily
// scoped to (or even a member of) any company. requirePlatformRole (applied
// inside platformRouter) is this namespace's own, separate authorization
// boundary — see platformAuthMiddleware.ts.
app.use("/api/v1/platform", authenticateUser, platformRouter)
app.use("*", async (_req, res) => {
  res.status(404).send("routes not found 404");
});
app.use(errorHandlerMiddleware);

const port = process.env.PORT || 5000;
const db = new Database({
  options: {
    // useNewUrlParser/useUnifiedTopology were deprecated no-ops in earlier
    // MongoDB driver versions; the driver bundled with Mongoose 9 rejects
    // them outright as unrecognized options.
    autoIndex: false, // Don't build indexes
    maxPoolSize: 10, // Maintain up to 10 socket connections
    serverSelectionTimeoutMS: 5000, // Keep trying to send operations for 5 seconds
    socketTimeoutMS: 45000, // Close sockets after 45 seconds of inactivity
    family: 4, // Use IPv4, skip trying IPv6
  },
  uri: process.env.MONGO_URI as string,
});
const start = async (): Promise<void> => {
  try {

    app.listen(port, () => {
      console.log(`app is running on port ${port} `);
    });
    await db.connect();
    cron.schedule("0 1 * * *", () => {
      runDailyOccurrenceGeneration();
    });
    cron.schedule("* * * * *", () => {
      sendUpcomingShiftReminders();
      autoCloseAbandonedShifts();
    });
    // 8am UTC — a reminder email landing at 1am does nobody any good.
    cron.schedule("0 8 * * *", () => {
      sendOverduePaymentReminders();
    });
    // 6am UTC, ahead of the payment-reminder run — drafts are ready for a
    // manager to review before the working day starts.
    cron.schedule("0 6 * * *", () => {
      generateRecurringInvoices();
    });
  } catch (err) {
    console.error(err);
  }
};
start();
export default app