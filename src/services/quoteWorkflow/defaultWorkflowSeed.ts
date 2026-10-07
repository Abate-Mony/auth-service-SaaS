// Starter content a brand-new company's QuoteWorkflow draft is seeded
// with — deliberately ONE fully worked example (every step type used at
// least once), not an exhaustive port of every old hardcoded branch.
// The whole point of the workflow builder is that an admin edits/adds/
// deletes from here; pre-loading ten branches they didn't ask for would
// just be a bigger template to fight, which is the opposite of what was
// asked for.
import type { QuoteWorkflowServiceType } from "../../models/quoteWorkflowModel.js";

export function buildDefaultWorkflowServiceTypes(): QuoteWorkflowServiceType[] {
    return [
        {
            key: "home-cleaning",
            label: "Home Cleaning",
            description: "Regular domestic cleaning",
            icon: "Home",
            order: 0,
            active: true,
            basePrice: 80,
            requiresManualQuote: false,
            // 3 questions per page rather than 1 — 12 one-question screens
            // is a lot to click through; this is also the seed's example
            // of the setting for whoever edits it.
            questionsPerPage: 3,
            depositPercentage: 0,
            autoSendQuoteOnSubmit: false,
            steps: [
                {
                    id: "property-type",
                    type: "choice",
                    label: "What type of property is it?",
                    required: true,
                    order: 0,
                    active: true,
                    options: [
                        { label: "Flat / Apartment", value: "flat", priceDelta: 0, order: 0 },
                        { label: "Terraced house", value: "terraced", priceDelta: 0, order: 1 },
                        { label: "Semi-detached house", value: "semi-detached", priceDelta: 0, order: 2 },
                        { label: "Detached house", value: "detached", priceDelta: 0, order: 3 },
                        { label: "Bungalow", value: "bungalow", priceDelta: 0, order: 4 },
                        { label: "Other", value: "other", priceDelta: 0, order: 5 },
                    ],
                },
                {
                    id: "bedrooms",
                    type: "number",
                    label: "How many bedrooms?",
                    required: true,
                    order: 1,
                    active: true,
                    numberConfig: { min: 1, max: 6, step: 1, pricePerUnit: 20 },
                },
                {
                    id: "bathrooms",
                    type: "number",
                    label: "How many bathrooms?",
                    subtitle: "Include any en-suites or shower rooms.",
                    required: true,
                    order: 2,
                    active: true,
                    numberConfig: { min: 1, max: 4, step: 1, pricePerUnit: 15 },
                },
                {
                    id: "frequency",
                    type: "choice",
                    label: "How often would you like cleaning?",
                    required: true,
                    order: 3,
                    active: true,
                    options: [
                        { label: "One-off", value: "one-off", priceDelta: 0, order: 0 },
                        { label: "Weekly", value: "weekly", priceDelta: 0, order: 1 },
                        { label: "Every 2 weeks", value: "fortnightly", priceDelta: 0, order: 2 },
                        { label: "Every 4 weeks", value: "monthly", priceDelta: 0, order: 3 },
                        { label: "Not sure yet", value: "not-sure", priceDelta: 0, order: 4 },
                    ],
                },
                {
                    id: "areas",
                    type: "multiselect",
                    label: "Which areas should we clean?",
                    subtitle: "Select all that apply.",
                    required: true,
                    order: 4,
                    active: true,
                    options: [
                        { label: "Kitchen", value: "kitchen", priceDelta: 0, order: 0 },
                        { label: "Bathrooms", value: "bathrooms", priceDelta: 0, order: 1 },
                        { label: "Bedrooms", value: "bedrooms", priceDelta: 0, order: 2 },
                        { label: "Living room", value: "living-room", priceDelta: 0, order: 3 },
                        { label: "Hallways / stairs", value: "hallways", priceDelta: 0, order: 4 },
                        { label: "Utility room", value: "utility-room", priceDelta: 0, order: 5 },
                        { label: "Conservatory", value: "conservatory", priceDelta: 0, order: 6 },
                    ],
                },
                {
                    id: "extras",
                    type: "multiselect",
                    label: "Would you like any extras?",
                    subtitle: "Optional add-ons — choose as many as you like.",
                    required: false,
                    order: 5,
                    active: true,
                    options: [
                        { label: "Oven cleaning", value: "oven", priceDelta: 55, order: 0 },
                        { label: "Fridge interior", value: "fridge", priceDelta: 25, order: 1 },
                        { label: "Interior windows", value: "windows", priceDelta: 35, order: 2 },
                        { label: "Inside kitchen cupboards", value: "cupboards", priceDelta: 40, order: 3 },
                    ],
                },
                {
                    id: "postcode",
                    type: "text",
                    label: "Where is the property?",
                    subtitle: "We'll use your postcode to confirm we cover your area.",
                    placeholder: "e.g. SN15 1AB",
                    required: true,
                    order: 6,
                    active: true,
                },
                {
                    id: "address",
                    type: "text",
                    label: "Street address",
                    placeholder: "e.g. 14 Example Road, Chippenham",
                    required: false,
                    order: 7,
                    active: true,
                },
                {
                    id: "preferredDate",
                    type: "date",
                    label: "When would you like the cleaning?",
                    subtitle: "Choose a preferred date — we'll confirm availability.",
                    required: false,
                    order: 8,
                    active: true,
                },
                {
                    id: "access",
                    type: "choice",
                    label: "How will our team access the property?",
                    required: true,
                    order: 9,
                    active: true,
                    options: [
                        { label: "Someone will be there", value: "someone-present", priceDelta: 0, order: 0 },
                        { label: "Key collection from you", value: "key-collection", priceDelta: 0, order: 1 },
                        { label: "Key safe", value: "key-safe", priceDelta: 0, order: 2 },
                        { label: "Concierge / reception", value: "concierge", priceDelta: 0, order: 3 },
                        { label: "Other", value: "other", priceDelta: 0, order: 4 },
                    ],
                },
                {
                    id: "freeText",
                    type: "textarea",
                    label: "Anything else you'd like us to know?",
                    subtitle: "Tell us in your own words.",
                    placeholder: "e.g. It's a 3-bed house with a large conservatory. We have a cat.",
                    required: false,
                    order: 10,
                    active: true,
                },
                {
                    id: "contact",
                    type: "contact",
                    label: "Where should we send your quote?",
                    subtitle: "We'll use these details to send your quote and follow up on this enquiry.",
                    required: true,
                    order: 11,
                    active: true,
                },
            ],
        },
    ];
}
