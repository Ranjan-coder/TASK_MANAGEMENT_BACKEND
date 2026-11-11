const multer = require("multer");
const ApiError = require("../utils/ApiError");

/**
 * Chat attachments are encrypted in the browser before upload, so the bytes
 * that arrive are ciphertext: the part is always application/octet-stream and
 * can't be sniffed. (The general upload filter only knew plain PDF/Office/image
 * types, so it refused every encrypted chat file.) What the file *is* comes as
 * the declared mimeType, which the controller checks against an allow-list.
 */
const MAX_BYTES = 20 * 1024 * 1024; // 20 MB, plus a little for the AES-GCM tag

const chatUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_BYTES + 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype === "application/octet-stream") return cb(null, true);
    cb(new ApiError(400, "Chat files must be encrypted before upload. Please reload the page."), false);
  }
});

module.exports = chatUpload;
