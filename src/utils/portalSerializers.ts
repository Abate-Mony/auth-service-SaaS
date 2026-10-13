// Client-safe views of internal models, for the /portal/* endpoints only.
// Whitelist-style everywhere (explicit field picking, never spread-then-
// delete) so a field added to Job/Invoice/Site/Quote in the future is
// excluded by default instead of silently leaking to a client until
// someone remembers to strip it here too.

// ── Booking (Job) ──────────────────────────────────────────────────────
// Job carries plenty that must never reach a client: payRate (worker pay),
// supervisor/checkInOverriddenBy (internal staff refs), createdBy,
// siteSnapshot.contact, checklist[].completedBy (worker identity),
// requiredWorkers/openToClaims/requiresApproval/geofence* (internal
// staffing/attendance mechanics), notes/instructions/attachment (internal
// ops text — no client-authorship distinction exists on these fields, so
// the safe default is to exclude them). chargeType/chargeRate/chargeAmount
// ARE kept — that's the client's own cost, legitimately client-facing,
// unlike payRate. Job has no `assignments` field at all (the relationship
// is inverted — JobAssignment.job points back), so there's no nested
// worker-assignment data to sanitize here by construction.
export const toPortalBooking = (job: any) => ({
  _id: job._id,
  title: job.title,
  description: job.description,
  date: job.date,
  startTime: job.startTime,
  endTime: job.endTime,
  minutes: job.minutes,
  location: job.location,
  address: job.address,
  coordinates: job.coordinates,
  status: job.status,
  priority: job.priority,
  site: job.site ? String(job.site) : null,
  siteSnapshot: job.siteSnapshot
    ? {
        name: job.siteSnapshot.name,
        accessInstructions: job.siteSnapshot.accessInstructions,
        parkingInstructions: job.siteSnapshot.parkingInstructions,
      }
    : null,
  chargeType: job.chargeType,
  chargeRate: job.chargeRate,
  chargeAmount: job.chargeAmount,
  billingStatus: job.billingStatus,
  invoice: job.invoice ? String(job.invoice) : null,
});

// ── Quote ───────────────────────────────────────────────────────────────
// Exact mirror of quoteController.ts's getPublicQuote whitelist (the
// existing public token-based client view) plus `_id` — that endpoint
// routes by token, the portal routes by real id. Deliberately NOT built
// from serializeQuote (same file), which spreads the entire raw document
// and would leak createdBy/source/depositPercentage/etc.
export const toPortalQuote = (quote: any) => ({
  _id: quote._id,
  quoteNumber: quote.quoteNumber,
  status: quote.status,
  title: quote.title,
  description: quote.description,
  client: quote.clientSnapshot,
  site: quote.siteSnapshot,
  items: quote.items,
  subtotal: quote.subtotal,
  taxRate: quote.taxRate,
  taxAmount: quote.taxAmount,
  total: quote.total,
  currency: quote.currency,
  validUntil: quote.validUntil,
  notes: quote.notes,
  terms: quote.terms,
  template: quote.templateSnapshot,
  sentAt: quote.sentAt,
  viewedAt: quote.viewedAt,
  acceptedAt: quote.acceptedAt,
  acceptedBy: quote.acceptedBy,
  declinedAt: quote.declinedAt,
  declinedBy: quote.declinedBy,
  declineReason: quote.declineReason,
});

// ── Invoice ─────────────────────────────────────────────────────────────
// Strips createdBy, assignments (JobAssignment refs — worker shift
// identity), template (internal design-system ref; templateSnapshot is
// the actual rendering source and is fine), remindersSent (internal
// dunning-cron state), cancelledBy, paymentNotes/notes/cancellationReason
// (free text with no client-authorship guarantee), sentTo. Per line item,
// strips `assignment`/`workerName` (worker identity) specifically.
// balanceDue/isOverdue/displayStatus are schema virtuals — call this on a
// hydrated doc via `.toObject({virtuals:true})`, not a bare `.lean()`
// result, or those three will be undefined.
export const toPortalInvoice = (invoice: any) => ({
  _id: invoice._id,
  invoiceNumber: invoice.invoiceNumber,
  currency: invoice.currency,
  clientSnapshot: invoice.clientSnapshot,
  jobs: (invoice.jobs ?? []).map((j: any) => String(j)),
  issueDate: invoice.issueDate,
  dueDate: invoice.dueDate,
  servicePeriod: invoice.servicePeriod,
  purchaseOrderNumber: invoice.purchaseOrderNumber,
  lineItems: (invoice.lineItems ?? []).map((li: any) => ({
    description: li.description,
    type: li.type,
    job: li.job ? String(li.job) : null,
    date: li.date,
    startTime: li.startTime,
    endTime: li.endTime,
    location: li.location,
    minutes: li.minutes,
    quantity: li.quantity,
    rate: li.rate,
    amount: li.amount,
  })),
  subtotal: invoice.subtotal,
  vatRate: invoice.vatRate,
  vatAmount: invoice.vatAmount,
  total: invoice.total,
  amountPaid: invoice.amountPaid,
  status: invoice.status,
  balanceDue: invoice.balanceDue,
  isOverdue: invoice.isOverdue,
  displayStatus: invoice.displayStatus,
  paidAt: invoice.paidAt,
  paymentReference: invoice.paymentReference,
  paymentMethod: invoice.paymentMethod,
});

// ── Site ────────────────────────────────────────────────────────────────
// Almost entirely client-safe by design — it's the client's own workplace
// record. Strips company/createdBy (internal scoping/staff identity) and
// geofenceMode/geofenceRadiusMeters (internal attendance-enforcement
// config, same treatment as on Job).
export const toPortalSite = (site: any) => ({
  _id: site._id,
  name: site.name,
  address: site.address,
  formattedAddress: site.formattedAddress,
  coordinates: site.coordinates,
  contact: site.contact,
  instructions: site.instructions,
  accessInstructions: site.accessInstructions,
  parkingInstructions: site.parkingInstructions,
  status: site.status,
});

// ── Booking request ────────────────────────────────────────────────────
// Nothing internal to strip beyond `reviewedBy` (a staff User ref) —
// everything else on this model is either the client's own input or
// review feedback meant for them to see.
export const toPortalBookingRequest = (request: any) => ({
  _id: request._id,
  service: request.service,
  preferredDate: request.preferredDate,
  preferredTime: request.preferredTime,
  notes: request.notes,
  status: request.status,
  reviewNotes: request.reviewNotes,
  convertedJob: request.convertedJob ? String(request.convertedJob) : null,
  createdAt: request.createdAt,
});

// ── Job change request (reschedule/cancel) ─────────────────────────────
// Same treatment as toPortalBookingRequest — strips `reviewedBy` (staff
// User ref), everything else is either the client's own input or review
// feedback meant for them to see.
export const toPortalJobChangeRequest = (request: any) => ({
  _id: request._id,
  job: request.job ? String(request.job) : null,
  type: request.type,
  requestedDate: request.requestedDate,
  requestedStartTime: request.requestedStartTime,
  requestedEndTime: request.requestedEndTime,
  reason: request.reason,
  originalDate: request.originalDate,
  originalStartTime: request.originalStartTime,
  originalEndTime: request.originalEndTime,
  status: request.status,
  reviewNotes: request.reviewNotes,
  createdAt: request.createdAt,
});
