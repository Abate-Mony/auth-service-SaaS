// Tidies address strings before they're stored, and for display.
//
// Why: the job location picker used to build `address` by appending the
// town and postcode to Google's formatted address, which already ends with
// them — "15 High St, Corsham SN13 0ES, UK, Corsham, SN13 0ES". Typed-in
// addresses can repeat parts too. This keeps the information and drops
// the repeats.

const tokens = (part: string) =>
    part.toLowerCase().replace(/[-–—]/g, " ").replace(/[^a-z0-9\s]/g, "").split(/\s+/).filter(Boolean);

/** Whether `inner`'s words appear, in order and next to each other, in `outer`. */
const containsWords = (outer: string[], inner: string[]) => {
    if (!inner.length || inner.length > outer.length) return false;
    for (let i = 0; i + inner.length <= outer.length; i++) {
        if (inner.every((w, j) => outer[i + j] === w)) return true;
    }
    return false;
};

/**
 * Removes comma-separated parts that repeat, or that are fully covered by
 * another part ("Corsham SN13" and "SN13 0ES" inside "Corsham SN13 0ES";
 * "Bradford on Avon" inside "Bradford-on-Avon BA15 1NL"). Whole words
 * only, so "Box" is kept next to "Boxford Rd". Order is preserved and
 * nothing else is changed — no countries or phone numbers are removed
 * here (see cleanAddress in timesheetFormat.ts for the display version).
 */
export function tidyAddress(input: string | null | undefined): string {
    if (!input) return input ?? "";
    const parts = input.split(",").map(p => p.trim().replace(/\s+/g, " ")).filter(Boolean);
    const words = parts.map(tokens);
    const kept = parts.filter((_, i) => {
        if (!words[i].length) return false;
        return !parts.some((__, j) => {
            if (j === i) return false;
            const same = words[j].join(" ") === words[i].join(" ");
            // An identical earlier part wins; otherwise a longer part that covers this one.
            return same ? j < i : words[j].length > words[i].length && containsWords(words[j], words[i]);
        });
    });
    return kept.join(", ");
}
