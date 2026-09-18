// utils/fetchImageBuffer.ts
//
// Fetches a remote image (a company's logo, stored on Cloudinary) into a
// Buffer pdfkit's doc.image() can draw directly — pdfkit can't take a
// remote URL itself. Never throws: a company's logo being temporarily
// unreachable must not break invoice/quote generation, it should just
// render without one, same as this file's own fallback-on-failure pattern
// elsewhere (e.g. sendCompanyEmail's provider fallback).
//
// Logo uploads accept JPEG/PNG/WebP (see multerMiddleware.ts), but pdfkit
// only natively draws JPEG and PNG — a WebP logo would otherwise silently
// fail to render. Every fetched image is normalized to PNG via sharp so the
// source format never matters.
import sharp from "sharp";

const FETCH_TIMEOUT_MS = 5000;

export async function fetchImageBuffer(url: string | null | undefined): Promise<Buffer | null> {
  if (!url) return null;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);

    if (!response.ok) return null;
    const arrayBuffer = await response.arrayBuffer();
    return await sharp(Buffer.from(arrayBuffer)).png().toBuffer();
  } catch (err) {
    console.error("fetchImageBuffer failed:", err);
    return null;
  }
}
