const express = require("express");
const router = express.Router();

const uploadController = require("../controllers/upload.controller");
const authMiddleware = require("../middlewares/auth.middleware");
const uploadMiddleware = require("../middlewares/upload.middleware");
const { uploadLimiter } = require("../middlewares/rateLimiter.middleware");
const validate = require("../middlewares/validate.middleware");
const { attachLinkSchema } = require("../validators/upload.validator");

router.use(authMiddleware);

// Upload a file (multipart/form-data)
router.post("/", uploadLimiter, uploadMiddleware.single("file"), uploadController.uploadFile);

// Upload profile avatar
router.post("/avatar", uploadLimiter, uploadMiddleware.single("file"), uploadController.uploadAvatar);

// Attach an external link
router.post("/link", validate(attachLinkSchema), uploadController.attachExternalLink);

// Get attachment metadata
router.get("/:id", uploadController.getAttachment);

// Delete an attachment
router.delete("/:id", uploadController.deleteAttachment);

module.exports = router;
