import { StatusCodes } from "http-status-codes";
import Stripe from "stripe";
import { z } from "zod";
import { BadRequestError, NotFoundError } from "../errors/customErrors.js";
import { getReqUser, MiddlewareFn } from "../interfaces/expresstype.js";
import Company from "../models/company.js";
import type { Plan } from "../utils/constant.js";

// Lazily constructed, not at module top level — ES module imports are
// hoisted and resolve before server.ts's own dotenv.config() call ever
// runs, so a module-top-level `new Stripe(process.env.STRIPE_SECRET_KEY)`
// would always see undefined regardless of what's actually in .env. Every
// exported handler below goes through this getter instead, which only
// ever runs at request time, long after dotenv has loaded.
//
// Pinned to an explicit API version rather than left to float on whatever
// the installed package's own default happens to be — current_period_end
// living on the subscription ITEM (not the subscription itself) and
// invoice.parent.subscription_details.subscription (not a flat
// invoice.subscription) are both shapes specific to this API version; a
// future `npm update stripe` must not silently change either without this
// being bumped deliberately.
let _stripe: Stripe | null = null;
function getStripe(): Stripe {
    if (!_stripe) {
        _stripe = new Stripe(process.env.STRIPE_SECRET_KEY as string, {
            apiVersion: "2026-09-30.endive",
        });
    }
    return _stripe;
}

// Same dotenv-timing reason as getStripe() above — read directly at call
// time, never cached at module load.
function getPriceId(plan: "starter" | "professional", billing: "monthly" | "annual"): string | undefined {
    const envKey = `STRIPE_PRICE_${plan.toUpperCase()}_${billing.toUpperCase()}`;
    return process.env[envKey];
}

// Only starter and professional ever have a configured price, so this can
// only ever resolve to one of those two tiers, never free/enterprise.
function resolvePlanFromPriceId(priceId: string | undefined): Plan | null {
    if (!priceId) return null;
    for (const planId of ["starter", "professional"] as const) {
        if (getPriceId(planId, "monthly") === priceId || getPriceId(planId, "annual") === priceId) {
            return planId;
        }
    }
    return null;
}

// The ONLY statuses where it's safe to re-derive `plan` from the
// subscription's current price. "active" means the subscription is
// genuinely, currently paid for. Every other status (past_due/unpaid/
// incomplete/incomplete_expired) deliberately leaves `plan` untouched
// below — this matters for an upgrade attempt specifically: if a renewal
// or a proration charge fails, the subscription's price may already point
// at a different tier while never having actually been paid for, and
// writing `plan` from price in that case would grant something that was
// never paid for. Deliberately NOT including "trialing" — this app's free
// trial (see Company.trialEndsAt, utils/expireTrials.ts) is a separate,
// non-Stripe mechanism granted automatically at signup with no card, not a
// Stripe-side trial on a real subscription.
//
// Exported for utils/expireTrials.ts, which needs the same "is this company
// actually covered by a real paid subscription" check to avoid downgrading
// a company that converted off its free trial onto real billing.
export const GRANT_STATUSES = ["active"];

// Statuses that block starting a second Checkout entirely — not just an
// already-active subscription. "incomplete" is included deliberately:
// letting a second Checkout proceed while an earlier attempt's subscription
// is still unresolved would mean two Stripe subscriptions simultaneously
// capable of successfully charging the same company, a real double-billing
// risk — "the newer one wins" in this app's own tracking says nothing about
// whether Stripe is still trying to collect on the older one in parallel.
const BLOCKING_STATUSES = ["active", "past_due", "unpaid", "incomplete"];

async function getOrCreateStripeCustomer(companyId: string, existingCustomerId: string | null): Promise<string> {
    if (existingCustomerId) return existingCustomerId;
    const customer = await getStripe().customers.create({ metadata: { companyId } });
    await Company.findByIdAndUpdate(companyId, { stripeCustomerId: customer.id });
    return customer.id;
}

// POST /companies/plan/checkout-session
export const createCheckoutSession: MiddlewareFn = async (req, res) => {
    const schema = z.object({
        plan: z.enum(["starter", "professional"]),
        billing: z.enum(["monthly", "annual"]),
    }).strict();
    const { plan, billing } = schema.parse(req.body);

    const companyId = getReqUser(req).company_id.toString();
    const company = await Company.findById(companyId).select("stripeCustomerId stripeSubscriptionId subscriptionStatus");
    if (!company) throw new NotFoundError("Company not found.");

    if (company.stripeSubscriptionId && BLOCKING_STATUSES.includes(company.subscriptionStatus ?? "")) {
        throw new BadRequestError("You already have a subscription in progress — use Manage billing, or wait for it to resolve, before starting a new one.");
    }

    const priceId = getPriceId(plan, billing);
    if (!priceId) throw new BadRequestError("This plan isn't available for checkout right now.");

    const customerId = await getOrCreateStripeCustomer(companyId, company.stripeCustomerId);

    // Guard against overlapping unfinished Checkout Sessions — a layer
    // before any subscription object even exists, so unlike the
    // subscription-level guard above, it's safe to resolve automatically
    // (a Session alone hasn't charged anything).
    const openSessions = await getStripe().checkout.sessions.list({ customer: customerId, status: "open", limit: 1 });
    const existingSession = openSessions.data[0];
    if (existingSession) {
        const lineItems = await getStripe().checkout.sessions.listLineItems(existingSession.id, { limit: 1 });
        if (lineItems.data[0]?.price?.id === priceId) {
            res.status(StatusCodes.OK).json({ success: true, url: existingSession.url });
            return;
        }
        // Different plan/billing requested than the abandoned session was
        // for — reusing it would check them out for the wrong thing.
        await getStripe().checkout.sessions.expire(existingSession.id);
    }

    const clientUrl = process.env.CLIENT_URL;
    const session = await getStripe().checkout.sessions.create(
        {
            mode: "subscription",
            customer: customerId,
            line_items: [{ price: priceId, quantity: 1 }],
            success_url: `${clientUrl}/settings/billing?checkout=success`,
            cancel_url: `${clientUrl}/settings/billing/checkout?plan=${plan}&billing=${billing}&checkout=cancelled`,
            metadata: { companyId },
            subscription_data: { metadata: { companyId } },
        },
        { idempotencyKey: `checkout-${companyId}-${plan}-${billing}-${Math.floor(Date.now() / (5 * 60 * 1000))}` }
    );

    res.status(StatusCodes.OK).json({ success: true, url: session.url });
};

// POST /companies/plan/portal-session
export const createPortalSession: MiddlewareFn = async (req, res) => {
    const companyId = getReqUser(req).company_id.toString();
    const company = await Company.findById(companyId).select("stripeCustomerId");
    if (!company) throw new NotFoundError("Company not found.");
    if (!company.stripeCustomerId) {
        throw new BadRequestError("Choose a plan first — there's no billing account to manage yet.");
    }

    const portalSession = await getStripe().billingPortal.sessions.create({
        customer: company.stripeCustomerId,
        return_url: `${process.env.CLIENT_URL}/settings/billing`,
    });

    res.status(StatusCodes.OK).json({ success: true, url: portalSession.url });
};

// Always re-fetches from Stripe rather than trusting the event payload —
// webhook delivery order isn't guaranteed, so an event carrying stale data
// arriving after a newer one has already been processed must not be
// allowed to overwrite the correct, current state.
async function syncSubscription(subscriptionId: string): Promise<void> {
    const subscription = await getStripe().subscriptions.retrieve(subscriptionId);
    const customerId = typeof subscription.customer === "string" ? subscription.customer : subscription.customer.id;
    const company = await Company.findOne({ stripeCustomerId: customerId });
    if (!company) return; // unknown customer — ignore, never throw (would make Stripe retry forever)

    // Guard against an OLDER, no-longer-canonical subscription's event (for
    // this same customer) clobbering a NEWER one this company has since
    // moved to. Compares Stripe's own `created` timestamps, not
    // event-arrival order, which webhook delivery order can't be trusted
    // to reflect.
    if (company.stripeSubscriptionId && company.stripeSubscriptionId !== subscription.id) {
        const currentlyTracked = await getStripe().subscriptions.retrieve(company.stripeSubscriptionId).catch(() => null);
        if (currentlyTracked && currentlyTracked.created > subscription.created) {
            return;
        }
    }

    const priceId = subscription.items.data[0]?.price.id;
    const plan = resolvePlanFromPriceId(priceId);

    company.stripeSubscriptionId = subscription.id;
    company.subscriptionStatus = subscription.status;
    company.cancelAtPeriodEnd = subscription.cancel_at_period_end;
    company.currentPeriodEnd = new Date(subscription.items.data[0].current_period_end * 1000);
    if (plan && GRANT_STATUSES.includes(subscription.status)) {
        company.plan = plan;
    }
    await company.save();
}

// customer.subscription.deleted gets its own handler, not syncSubscription
// — the deleted subscription's price would otherwise resolve back to a
// paid tier, which is exactly wrong for a cancelled subscription.
async function handleSubscriptionDeleted(subscription: Stripe.Subscription): Promise<void> {
    const company = await Company.findOne({ stripeSubscriptionId: subscription.id });
    if (!company) return;
    // Only act if this is still the subscription we're tracking — guards
    // against a stale cancellation event for an OLD subscription arriving
    // after the company has since started a newer replacement one.
    if (company.stripeSubscriptionId !== subscription.id) return;

    company.plan = "free";
    company.subscriptionStatus = "canceled";
    company.cancelAtPeriodEnd = false;
    company.currentPeriodEnd = null;
    // stripeCustomerId deliberately kept — reusable if they resubscribe.
    await company.save();
}

function extractSubscriptionId(invoice: Stripe.Invoice): string | null {
    const ref = invoice.parent?.subscription_details?.subscription;
    if (!ref) return null;
    return typeof ref === "string" ? ref : ref.id;
}

// POST /api/v1/stripe/webhook — mounted directly on `app` in server.ts,
// before the global express.json(), with its own raw-body parser. No auth
// middleware: Stripe calls this directly, verification is the signature
// check below, not a session.
export const stripeWebhookHandler: MiddlewareFn = async (req, res) => {
    const signature = req.headers["stripe-signature"];
    let event: Stripe.Event;
    try {
        event = getStripe().webhooks.constructEvent(req.body as Buffer, signature as string, process.env.STRIPE_WEBHOOK_SECRET as string);
    } catch (err) {
        console.error("Stripe webhook signature verification failed:", err);
        res.status(StatusCodes.BAD_REQUEST).json({ success: false, msg: "Invalid signature." });
        return;
    }

    switch (event.type) {
        case "customer.subscription.created":
        case "customer.subscription.updated":
            await syncSubscription(event.data.object.id);
            break;
        case "customer.subscription.deleted":
            await handleSubscriptionDeleted(event.data.object);
            break;
        case "invoice.paid":
        case "invoice.payment_failed": {
            const subscriptionId = extractSubscriptionId(event.data.object);
            if (subscriptionId) await syncSubscription(subscriptionId);
            break;
        }
        case "checkout.session.completed":
            // Logged only, never mutates Company — customer.subscription.created
            // already covers the real state change (Stripe creates the
            // Subscription as part of completing a subscription-mode
            // Checkout Session regardless, so this would just be a second,
            // redundant write path for the same state).
            console.log(`Checkout session completed: ${event.data.object.id}`);
            break;
        default:
            break;
    }

    // Any processing error above propagates past this point to a 500 (not
    // caught here), so Stripe's own retry schedule retries delivery rather
    // than this silently acking a failed write with a 200.
    res.status(StatusCodes.OK).json({ received: true });
};
