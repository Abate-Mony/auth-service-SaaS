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
import { v2 as cloudinary } from 'cloudinary';
import authRouter from "./routes/authRouter.js";
import userRouter from "./routes/userRouter.js";
import Database from "./db/connections.js";
import errorHandlerMiddleware from "./middleware/errorHandlerMiddleware.js";
import calendarRouter from "./routes/calendarRouter.js"
import cors from "cors";
import { authenticateUser } from "./middleware/authMiddleware.js";
import jobRouter from "./routes/jobRouter.js";
import workerRouter from "./routes/workerRouter.js"
import activityLogRouter from "./routes/activity_logs_router.js"
import companyRouter from "./routes/companyRouter.js"
import cron from "node-cron";
import { runDailyOccurrenceGeneration } from "./utils/runDailyOccurrenceGeneration.js";
import { sendUpcomingShiftReminders } from "./utils/sendUpcomingShiftReminders.js";
import notificationPreferenceRouter
  from "./routes/notificationPreferenceRouter.js";
  import timesheetRouter from "./routes/timesheetRouter.js";
const app = express();
app.use(express.json());
// TEMP: every-second interval to stress-test generateOccurrences' race-condition fix. Revert to "0 1 * * *" before committing/deploying.

const __dirname = dirname(fileURLToPath(import.meta.url));
const filepath = path.resolve(__dirname, "../public/");
console.log(`this is the file path here :`, filepath);
app.use(
  cors({
    origin: true,
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
// DONE WITH USERS DOCUMENTATION ON POSTMAN
app.use(`/api/v1/users`,
  authenticateUser,
  userRouter);
// DONE WITH USERS DOCUMENTATION ON POSTMAN
app.use("/api/v1/jobs", authenticateUser, jobRouter);
// DONE WITH WORKERS DOCUMENTATION ON POSTMAN
app.use("/api/v1/workers",
  authenticateUser,
  workerRouter
)
app.use(
  "/api/v1/notification-preferences",
  authenticateUser,
  notificationPreferenceRouter
);
app.use("/api/v1/activity-logs", authenticateUser, activityLogRouter);
app.use("/api/v1/companies", authenticateUser, companyRouter);
app.use(
  "/api/v1/timesheets",
  authenticateUser,
  timesheetRouter
);
app.use("/api/v1/calendar", calendarRouter)
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
    });
  } catch (err) {
    console.log(err);
  }
};
start();
export default app