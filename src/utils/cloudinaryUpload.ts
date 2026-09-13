import { v2 as cloudinary } from "cloudinary";
import { formatImage } from "../middleware/multerMiddleware.js";

export interface UploadedFile {
  url: string;
  publicId: string;
  resourceType: "image" | "raw";
}

// Shared by every feature that accepts a file (worker documents, job
// attachments, ...) so the multer-buffer -> datauri -> Cloudinary path is
// written once. resource_type "auto" lets Cloudinary classify PDFs vs
// images itself; we store whatever it decided so a later delete can pass
// the exact same value back (destroy() requires the right resource_type or
// it silently no-ops).
export async function uploadFileToCloudinary(file: any, folder: string): Promise<UploadedFile> {
  const dataUri = formatImage(file);
  const result = await cloudinary.uploader.upload(dataUri, {
    folder,
    resource_type: "auto",
  });
  return {
    url: result.secure_url,
    publicId: result.public_id,
    resourceType: result.resource_type === "raw" ? "raw" : "image",
  };
}

export async function deleteFileFromCloudinary(publicId: string, resourceType: "image" | "raw"): Promise<void> {
  await cloudinary.uploader.destroy(publicId, { resource_type: resourceType });
}
