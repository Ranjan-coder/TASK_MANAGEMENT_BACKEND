const crypto = require("crypto");
const cloudinary = require("../config/cloudinary");
const config = require("../config/env");
const ApiError = require("../utils/ApiError");
const logger = require("../utils/logger");
const { stripImageMetadata } = require("../utils/imageMetadata");
const { requireOrgId, currentOrgId } = require("../utils/tenantContext");
const { getCachedSlug } = require("./organisation.service");

/**
 * Campaign / catalog media. Files are identified by their actual bytes (magic
 * numbers), never by the name or the browser's claimed type. SVG is never
 * accepted (it can carry script).
 */
const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"];
// m4v / 3gp: what many phones record (same MP4 family; Cloudinary transcodes them)
const VIDEO_TYPES = ["video/mp4", "video/webm", "video/quicktime", "video/x-m4v", "video/3gpp"];
const IMAGE_TIMEOUT_MS = 60 * 1000;
// A 50 MB video needs minutes on an ordinary uplink, not one
const VIDEO_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_VIDEO_BYTES = 50 * 1024 * 1024;
const MAX_VIDEO_SECONDS = 60;
const FOLDERS = { campaign: "campaigns", catalog: "catalog" };
// Where the first organisation's media lived before tenancy (still valid for it only)
const LEGACY_FOLDERS = { campaign: "bonito/campaigns", catalog: "bonito/catalog" };
const LEGACY_SLUG = (process.env.TENANT_DEFAULT_SLUG || "bonito").toLowerCase();

/**
 * Every organisation's files live under their own folder, "org_<orgId>/<kind>"
 * (module-access-plan.md, Phase 5). Records stay the real access control; the
 * folder makes ownership visible and lets isOwnMedia refuse another
 * organisation's files.
 */
const orgFolder = (kind) => `org_${requireOrgId()}/${kind}`;

/**
 * The full public id ("org_<id>/<kind>/<time>_<random>") is chosen here rather
 * than through Cloudinary's `folder` option: accounts in dynamic folder mode
 * ignore `folder` for the public id, which made isOwnMedia reject every
 * upload. Passing the path in the id gives the same result in both modes.
 */
const storedId = (kind, ext = "") => `${orgFolder(kind)}/${Date.now()}_${crypto.randomBytes(8).toString("hex")}${ext}`;

const sniff = async (buffer) => {
  const { fileTypeFromBuffer } = await import("file-type");
  return fileTypeFromBuffer(buffer);
};

const cloudinaryReady = () => Boolean(cloudinary.config().cloud_name && cloudinary.config().api_secret);

const uploadBuffer = (buffer, options) =>
  new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream({ timeout: IMAGE_TIMEOUT_MS, ...options }, (err, result) => (err ? reject(err) : resolve(result)));
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
        ? "Upload a JPG, PNG or WebP image, or an MP4, MOV, M4V, 3GP or WebM video."
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
      public_id: storedId(FOLDERS[purpose]),
      resource_type: isVideo ? "video" : "image",
      overwrite: false,
      ...(isVideo ? { timeout: VIDEO_TIMEOUT_MS } : {})
    });
  } catch (err) {
    logger.error(`Cloudinary upload failed: ${err.message}`);
    throw new ApiError(502, "Couldn't upload the file right now. Please try again.");
  }

  if (isVideo && Number(result.duration) > MAX_VIDEO_SECONDS) {
    await destroyMedia(result.public_id, "video");
    throw new ApiError(400, `Videos must be ${MAX_VIDEO_SECONDS} seconds or shorter (this one is ${Math.round(result.duration)} s).`);
  }

  return toAsset(result, isVideo);
};

/** The media object the editors store (same shape for every upload path). */
const toAsset = (result, isVideo) => ({
  url: isVideo ? videoUrl(result.public_id) : imageUrl(result.public_id),
  publicId: result.public_id,
  resourceType: isVideo ? "video" : "image",
  posterUrl: isVideo ? videoPosterUrl(result.public_id) : null,
  width: result.width,
  height: result.height,
  duration: isVideo && Number.isFinite(Number(result.duration)) ? Number(result.duration) : undefined,
  bytes: result.bytes
});

// ── Campaign videos: straight from the browser to Cloudinary, in chunks ──────
//
// Relaying a video through this server meant holding all of it in memory and
// keeping the browser waiting through two uploads in a row (browser → server →
// Cloudinary); a slow second leg ended in a timeout with no message. Now:
//   1. ticket: the server signs the upload. The public id (this organisation's
//      folder) and the allowed formats are part of the signature, so the
//      browser can't store anything elsewhere or of another kind.
//   2. the browser sends the file to Cloudinary in CHUNK_BYTES pieces
//      (progress per piece, a failed piece is retried alone).
//   3. finish: the server asks Cloudinary what actually arrived (format, size,
//      length) and deletes it if it breaks a rule. The browser's word is never
//      taken for any of it.

const VIDEO_FORMATS = ["mp4", "mov", "m4v", "3gp", "webm"];
// Cloudinary: every chunk but the last must be over 5 MB
const CHUNK_BYTES = 6 * 1024 * 1024;

const videoUploadTicket = (bytes) => {
  if (!cloudinaryReady()) throw new ApiError(503, "Media storage is not configured (Cloudinary).");
  if (bytes > MAX_VIDEO_BYTES) throw new ApiError(400, "Videos must be 50 MB or smaller.");
  const { cloud_name: cloud, api_key: apiKey, api_secret: secret } = cloudinary.config();
  // Signatures are refused by Cloudinary after an hour
  const params = {
    public_id: storedId(FOLDERS.campaign),
    timestamp: Math.floor(Date.now() / 1000),
    allowed_formats: VIDEO_FORMATS.join(",")
  };
  return {
    uploadUrl: `https://api.cloudinary.com/v1_1/${cloud}/video/upload`,
    fields: { ...params, api_key: apiKey, signature: cloudinary.utils.api_sign_request(params, secret) },
    uploadId: crypto.randomBytes(16).toString("hex"),
    chunkBytes: CHUNK_BYTES
  };
};

/** Duration from the Admin API (its key isn't fixed across accounts/versions). */
const durationOf = (r) => {
  const d = Number(r.duration ?? r.video_metadata?.duration ?? r.media_metadata?.duration ?? r.video?.duration);
  return Number.isFinite(d) ? d : null;
};

const finishVideoUpload = async (publicId, expectedBytes) => {
  if (!cloudinaryReady()) throw new ApiError(503, "Media storage is not configured (Cloudinary).");
  // Only ids a ticket for this organisation could have produced
  if (!isOwnMedia(videoUrl(publicId), publicId, "campaign")) throw new ApiError(400, "Upload the video through the campaign editor");
  let r;
  try {
    r = await cloudinary.api.resource(publicId, { resource_type: "video", media_metadata: true });
  } catch (err) {
    const code = err?.error?.http_code ?? err?.http_code;
    if (code === 404) throw new ApiError(400, "The video didn't finish uploading. Please try again.");
    logger.error(`Cloudinary lookup failed for ${publicId}: ${err?.error?.message || err?.message}`);
    throw new ApiError(502, "Couldn't check the video right now. Please try again.");
  }
  const duration = durationOf(r);
  // Cloudinary answers the last piece even if an earlier one never arrived
  // (seen on a real account: a lone last piece stored as a "complete" file)
  const problem = Number(r.bytes) !== expectedBytes
    ? "The video didn't upload completely (part of it never arrived). Please upload it again."
    : !VIDEO_FORMATS.includes(String(r.format).toLowerCase())
    ? "Upload an MP4, MOV, M4V, 3GP or WebM video."
    : Number(r.bytes) > MAX_VIDEO_BYTES
      ? "Videos must be 50 MB or smaller."
      : duration !== null && duration > MAX_VIDEO_SECONDS + 0.5
        ? `Videos must be ${MAX_VIDEO_SECONDS} seconds or shorter (this one is ${Math.round(duration)} s).`
        : null;
  if (problem) {
    await destroyMedia(publicId, "video");
    throw new ApiError(400, problem);
  }
  if (duration === null) logger.warn(`No duration from Cloudinary for ${publicId}; length not checked`);
  return toAsset({ ...r, public_id: publicId, duration }, true);
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
  const orgId = currentOrgId();
  if (!orgId) return false;
  // This organisation's folder only (the first organisation may also keep its older files)
  const prefixes = [`org_${orgId}/${FOLDERS[purpose]}/`];
  if (getCachedSlug(orgId) === LEGACY_SLUG) prefixes.push(`${LEGACY_FOLDERS[purpose]}/`);
  if (!prefixes.some((p) => publicId.startsWith(p)) || !/^[A-Za-z0-9_\-/]+$/.test(publicId) || publicId.includes("//") || publicId.includes("..")) return false;
  // The URL must be exactly one this server builds for that file (no /fetch/ remote URLs, no other accounts)
  return [imageUrl(publicId), videoUrl(publicId), videoPosterUrl(publicId)].includes(url);
};

// ── Report evidence (screenshots) ─────────────────────────────────────────────
const MAX_EVIDENCE_BYTES = 8 * 1024 * 1024;
const EVIDENCE_FOLDER = "reports";

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
      public_id: storedId(EVIDENCE_FOLDER),
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
      public_id: storedId("invoices", ".pdf"),
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
  orgFolder,
  uploadInvoicePdf,
  invoiceUrl,
  destroyInvoice,
  MAX_PDF_BYTES,
  uploadMedia,
  videoUploadTicket,
  finishVideoUpload,
  destroyMedia,
  isOwnMedia,
  uploadEvidenceImage,
  evidenceUrl,
  destroyEvidence,
  MAX_VIDEO_BYTES,
  MAX_EVIDENCE_BYTES,
  _internals: { sniff, imageUrl, videoUrl, videoPosterUrl }
};
