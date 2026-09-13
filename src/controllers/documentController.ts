import type { Request, Response } from "express";
import { StatusCodes } from "http-status-codes";

import User from "../models/userModel.js";
import { getReqUser } from "../interfaces/expresstype.js";
import { BadRequestError, NotFoundError } from "../errors/customErrors.js";
import { uploadFileToCloudinary, deleteFileFromCloudinary } from "../utils/cloudinaryUpload.js";

// Self-service — a worker uploads a document about themselves (ID,
// right-to-work, certifications, ...). Optional by design: nothing in this
// app requires a worker to have any documents on file.
export const uploadMyDocument = async (req: Request, res: Response) => {
  const currentUser = getReqUser(req);
  const file = (req as any).file;
  if (!file) throw new BadRequestError("Select a file to upload.");

  const name = (req.body?.name ?? "").trim();
  if (!name) throw new BadRequestError("Give the document a name.");

  const uploaded = await uploadFileToCloudinary(file, `worker-documents/${currentUser.company_id}/${currentUser.user_id}`);

  const user = await User.findByIdAndUpdate(
    currentUser.user_id,
    {
      $push: {
        documents: {
          name,
          url: uploaded.url,
          publicId: uploaded.publicId,
          resourceType: uploaded.resourceType,
          mimeType: file.mimetype,
        },
      },
    },
    { new: true }
  ).select("documents");

  if (!user) throw new NotFoundError("User not found.");

  res.status(StatusCodes.CREATED).json({ documents: user.documents });
};

export const getMyDocuments = async (req: Request, res: Response) => {
  const currentUser = getReqUser(req);
  const user = await User.findById(currentUser.user_id).select("documents");
  if (!user) throw new NotFoundError("User not found.");
  res.status(StatusCodes.OK).json({ documents: user.documents });
};

export const deleteMyDocument = async (req: Request, res: Response) => {
  const currentUser = getReqUser(req);
  const { documentId } = req.params;

  const user = await User.findById(currentUser.user_id).select("documents");
  if (!user) throw new NotFoundError("User not found.");

  const doc = user.documents?.find((d: any) => d._id.toString() === documentId);
  if (!doc) throw new NotFoundError("Document not found.");

  await deleteFileFromCloudinary(doc.publicId, doc.resourceType as "image" | "raw");

  user.documents = user.documents!.filter((d: any) => d._id.toString() !== documentId) as any;
  await user.save();

  res.status(StatusCodes.OK).json({ documents: user.documents });
};

// Admin/manager view of a specific worker's documents — company-scoped so
// one company can never see another's workers' files.
export const getWorkerDocuments = async (req: Request, res: Response) => {
  const currentUser = getReqUser(req);
  const { workerId } = req.params;

  const worker = await User.findOne({ _id: workerId, company: currentUser.company_id }).select("documents fullname");
  if (!worker) throw new NotFoundError("Worker not found.");

  res.status(StatusCodes.OK).json({ documents: worker.documents, workerName: worker.fullname });
};
