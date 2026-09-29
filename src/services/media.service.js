const crypto = require("crypto");
const cloudinary = require("../config/cloudinary");
const config = require("../config/env");
const ApiError = require("../utils/ApiError");
const logger = require("../utils/logger");
const { stripImageMetadata } = require("../utils/imageMetadata");

/**
 * Campaign / catalog media. Files are identified by their actual bytes (magic
 * numbers), never by the name or the browser's claimed type. SVG is never
 * accepted (it can carry script).
 */
const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"];
const VIDEO_TYPES = ["video/mp4", "video/webm", "video/quicktime"];
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_VIDEO_BYTES = 50 * 1024 * 1024;
const MAX_VIDEO_SECONDS = 60;
const FOLDERS = { campaign: "bonito/campaigns", catalog: "bonito/catalog" };

const sniff = async (buffer) => {
  const { fileTypeFromBuffer } = await import("file-type");
  return fileTypeFromBuffer(buffer);
};

const cloudinaryReady = () => Boolean(cloudinary.config().cloud_name && cloudinary.config().api_secret);

const uploadBuffer = (buffer, options) =>
  new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream({ timeout: 60000, ...options }, (err, result) => (err ? reject(err) : resolve(result)));
    stream.end(buffer);
  });

/** Delivery URLs: auto format/quality (also strips photo metadata such as GPS). */
const imageUrl = (publicId, width = 1600) =>
  cloudinary.url(publicId, { secure: true, transformation: [{ width, crop: "limit", quality: "auto", fetch_format: "auto" }] });
const videoUrl = (publicId) =>
  cloudinary.url(publicId, { secure: true, resource_type: "video", transformation: [{ quality: "auto", fetch_format: "auto" }] });
const videoPosterUrl = (publicId) =>
  cloudinary.url(publicId, {
    secure: true,
    resource_type: "video",
    format: "jpg",
    transformation: [{ start_offset: "1", width: 1600, crop: "limit", quality: "auto" }]
  });

/**
 * @param {Buffer} buffer
 * @param {"campaign"|"catalog"} purpose  catalog accepts images only
 */
const uploadMedia = async (buffer, purpose) => {
  if (!FOLDERS[purpose]) throw new ApiError(400, "Unknown media purpose");
  if (!cloudinaryReady()) throw new ApiError(503, "Media storage is not configured (Cloudinary).");

  const detected = await sniff(buffer);
  const mime = detected?.mime;
  const isImage = IMAGE_TYPES.includes(mime);
  const isVideo = VIDEO_TYPES.includes(mime) && purpose === "campaign";
  if (!isImage && !isVideo) {
    throw new ApiError(
      400,
      purpose === "campaign"
        ? "Upload a JPG, PNG or WebP image, or an MP4/WebM/MOV video."
        : "Upload a JPG, PNG or WebP image."
    );
  }
  if (isImage && buffer.length > MAX_IMAGE_BYTES) throw new ApiError(400, "Images must be 10 MB or smaller.");
  if (isVideo && buffer.length > MAX_VIDEO_BYTES) throw new ApiError(400, "Videos must be 50 MB or smaller.");

  // Campaign/catalog photos: remove EXIF/GPS (the original is reachable on Cloudinary, not just resized copies)
  if (isImage) buffer = stripImageMetadata(buffer, mime);
  let result;
  try {
    result = await uploadBuffer(buffer, {
      folder: FOLDERS[purpose],
      public_id: `${Date.now()}_${crypto.randomBytes(8).toString("hex")}`,
      resource_type: isVideo ? "video" : "image",
      overwrite: false
    });
  } catch (err) {
    logger.error(`Cloudinary upload failed: ${err.message}`);
    throw new ApiError(502, "Couldn't upload the file right now. Please try again.");
  }

  if (isVideo && Number(result.duration) > MAX_VIDEO_SECONDS) {
    await destroyMedia(result.public_id, "video");
    throw new ApiError(400, `Videos must be ${MAX_VIDEO_SECONDS} seconds or shorter (this one is ${Math.round(result.duration)} s).`);
  }

  return {
    url: isVideo ? videoUrl(result.public_id) : imageUrl(result.public_id),
    publicId: result.public_id,
    resourceType: isVideo ? "video" : "image",
    posterUrl: isVideo ? videoPosterUrl(result.public_id) : null,
    width: result.width,
    height: result.height,
    duration: isVideo ? Number(result.duration) : undefined,
    bytes: result.bytes
  };
};

/** Best-effort removal of a replaced/deleted asset. */
const destroyMedia = async (publicId, resourceType = "image") => {
  if (!publicId || !cloudinaryReady()) return;
  try {
    await cloudinary.uploader.destroy(publicId, { resource_type: resourceType, invalidate: true });
  } catch (err) {
    logger.warn(`Cloudinary delete failed for ${publicId}: ${err.message}`);
  }
};

/**
 * Only accept media this server uploaded: our Cloudinary account, our folders.
 * Stops arbitrary external URLs (tracking pixels, hotlinks) being stored.
 */
const isOwnMedia = (url, publicId, purpose) => {
  const cloud = config.cloudinary.cloudName;
  if (typeof url !== "string" || typeof publicId !== "string" || !cloud || !FOLDERS[purpose]) return false;
  if (!publicId.startsWith(`${FOLDERS[purpose]}/`) || !/^[A-Za-z0-9_\-/]+$/.test(publicId) || publicId.includes("//") || publicId.includes("..")) return false;
  // The URL must be exactly one this server builds for that file (no /fetch/ remote URLs, no other accounts)
  return [imageUrl(publicId), videoUrl(publicId), videoPosterUrl(publicId)].includes(url);
};

// ── Report evidence (screenshots) ─────────────────────────────────────────────
const MAX_EVIDENCE_BYTES = 8 * 1024 * 1024;
const EVIDENCE_FOLDER = "bonito/reports";

/**
 * Stores a report screenshot privately (not reachable by a public URL),
 * after removing hidden metadata such as GPS location.
 */
const uploadEvidenceImage = async (buffer) => {
  if (!cloudinaryReady()) throw new ApiError(503, "Media storage is not configured (Cloudinary).");
  const detected = await sniff(buffer);
  if (!IMAGE_TYPES.includes(detected?.mime)) throw new ApiError(400, "Screenshots must be JPG, PNG or WebP images.");
  if (buffer.length > MAX_EVIDENCE_BYTES) throw new ApiError(400, "Each screenshot must be 8 MB or smaller.");
  // Cloudinary keeps EXIF/GPS on upload, so remove it here first
  const clean = stripImageMetadata(buffer, detected.mime);
  let result;
  try {
    result = await uploadBuffer(clean, {
      folder: EVIDENCE_FOLDER,
      public_id: `${Date.now()}_${crypto.randomBytes(8).toString("hex")}`,
      resource_type: "image",
      type: "private",
      format: "jpg",
      transformation: [{ width: 2400, height: 2400, crop: "limit", quality: 90 }],
      overwrite: false
    });
  } catch (err) {
    logger.error(`Cloudinary evidence upload failed: ${err.message}`);
    throw new ApiError(502, "Couldn't upload the screenshot right now. Please try again.");
  }
  return { publicId: result.public_id, width: result.width, height: result.height, bytes: result.bytes };
};

/** Short-lived (10 min) link to a private screenshot, for admins reviewing a report. */
const evidenceUrl = (publicId) =>
  cloudinary.utils.private_download_url(publicId, "jpg", {
    type: "private",
    resource_type: "image",
    expires_at: Math.floor(Date.now() / 1000) + 600
  });

const destroyEvidence = async (publicId) => {
  if (!publicId || !cloudinaryReady()) return;
  try {
    await cloudinary.uploader.destroy(publicId, { resource_type: "image", type: "private", invalidate: true });
  } catch (err) {
    logger.warn(`Cloudinary delete failed for ${publicId}: ${err.message}`);
  }
};

// ── Invoices (PDF, private) ──────────────────────────────────────────────────
const MAX_PDF_BYTES = 10 * 1024 * 1024;

const uploadInvoicePdf = async (buffer) => {
  if (!cloudinaryReady()) throw new ApiError(503, "Media storage is not configured (Cloudinary).");
  const detected = await sniff(buffer);
  if (detected?.mime !== "application/pdf") throw new ApiError(400, "Invoices must be PDF files.");
  if (buffer.length > MAX_PDF_BYTES) throw new ApiError(400, "Invoices must be 10 MB or smaller.");
  try {
    const result = await uploadBuffer(buffer, {
      folder: "bonito/invoices",
      public_id: `${Date.now()}_${crypto.randomBytes(8).toString("hex")}.pdf`,
      resource_type: "raw",
      type: "private",
      overwrite: false
    });
    return { publicId: result.public_id, bytes: result.bytes };
  } catch (err) {
    logger.error(`Cloudinary invoice upload failed: ${err.message}`);
    throw new ApiError(502, "Couldn't upload the invoice right now. Please try again.");
  }
};

/** 10-minute link to a private invoice PDF. */
const invoiceUrl = (publicId) =>
  cloudinary.utils.private_download_url(publicId, "", { type: "private", resource_type: "raw", expires_at: Math.floor(Date.now() / 1000) + 600, attachment: true });

const destroyInvoice = async (publicId) => {
  if (!publicId || !cloudinaryReady()) return;
  try {
    await cloudinary.uploader.destroy(publicId, { resource_type: "raw", type: "private", invalidate: true });
  } catch (err) {
    logger.warn(`Cloudinary delete failed for ${publicId}: ${err.message}`);
  }
};

module.exports = {
  uploadInvoicePdf,
  invoiceUrl,
  destroyInvoice,
  MAX_PDF_BYTES,
  uploadMedia,
  destroyMedia,
  isOwnMedia,
  uploadEvidenceImage,
  evidenceUrl,
  destroyEvidence,
  MAX_VIDEO_BYTES,
  MAX_EVIDENCE_BYTES,
  _internals: { sniff, imageUrl, videoUrl, videoPosterUrl }
};
