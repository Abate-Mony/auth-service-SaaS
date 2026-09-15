import multer from "multer";
import DataParser from "datauri/parser.js";
import path from "path";
import { BadRequestError } from "../errors/customErrors.js";

const storage = multer.memoryStorage();

const ALLOWED_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "application/pdf",
]);

const IMAGE_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
]);

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB — job attachments, worker documents
  fileFilter: (_req, file, cb) => {
    if (!ALLOWED_MIME_TYPES.has(file.mimetype)) {
      cb(new BadRequestError("Only JPG, PNG, WEBP or PDF files are allowed."));
      return;
    }
    cb(null, true);
  },
});

// Avatar-style images only — profile photo, company logo. Capped much
// smaller than the general upload() above since these are small display
// images, not documents, and never need to be a PDF.
export const uploadAvatar = multer({
  storage,
  limits: { fileSize: 500_000 }, // 500KB
  fileFilter: (_req, file, cb) => {
    if (!IMAGE_MIME_TYPES.has(file.mimetype)) {
      cb(new BadRequestError("Only JPG, PNG or WEBP images are allowed."));
      return;
    }
    cb(null, true);
  },
});

const parser = new DataParser();

export const formatImage = (file: any) => {
  const fileExtension = path.extname(file.originalname).toString();
  return parser.format(fileExtension, file.buffer).content;
};

export default upload;
