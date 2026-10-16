// Every new company starts on a 30-day, no-card Professional trial (see
// authControler.ts's register and Company.trialEndsAt's own comment). This
// is the other half: once trialEndsAt passes, revert to "free" — unless
// the company has since started a real paid Stripe subscription, in which
// case billingController.ts's syncSubscription already owns `plan` and
// this must leave it alone.
import { GRANT_STATUSES } from "../controllers/billingController.js";
import Company from "../models/company.js";

let running = false;

export async function expireTrials() {
  if (running) return;
  running = true;

  try {
    const now = new Date();

    // plan: { $ne: "free" } makes this self-limiting — a company already
    // reverted by a previous run no longer matches, so there's no need for
    // a separate "already processed" marker.
    const expired = await Company.find({
      trialEndsAt: { $lte: now },
      plan: { $ne: "free" },
    }).select("plan stripeSubscriptionId subscriptionStatus");

    for (const company of expired) {
      const hasRealSubscription =
        !!company.stripeSubscriptionId &&
        GRANT_STATUSES.includes(company.subscriptionStatus ?? "");
      if (hasRealSubscription) continue;

      try {
        company.plan = "free";
        await company.save();
      } catch (err) {
        console.error(`Failed to expire trial for company ${company._id}:`, err);
      }
    }
  } finally {
    running = false;
  }
}
