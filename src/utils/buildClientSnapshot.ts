// Shared by quoteController.ts and invoice/createDepositInvoice.ts (and, via
// createQuoteFromLeadIntake.ts, the public wizard's quote-creation path) —
// a plain utility rather than living inside quoteController.ts so none of
// these modules need to import each other to reach it.
import type Client from "../models/clientModel.js";

export const buildClientSnapshot = (client: InstanceType<typeof Client>) => ({
    name: client.name,
    billingEmail: client.billingEmail,
    vatNumber: client.vatNumber,
    phone: client.phone,
    contactName: client.contacts?.find((c: any) => c.isPrimary)?.name ?? client.contacts?.[0]?.name,
    address: client.address,
});
