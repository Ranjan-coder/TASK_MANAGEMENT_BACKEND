const express = require("express");
const router = express.Router();

const commentController = require("../controllers/comment.controller");
const authMiddleware = require("../middlewares/auth.middleware");
const { verifyTaskAccess, verifyCommentOwnership } = require("../middlewares/verifyAccess.middleware");
const validate = require("../middlewares/validate.middleware");
const { addCommentSchema, updateCommentSchema } = require("../validators/comment.validator");

router.use(authMiddleware);

/**
 * These routes are mounted at /api/v1 (root) in app.js to support both:
 *   GET  /api/v1/tasks/:taskId/comments
 *   POST /api/v1/tasks/:taskId/comments
 *   PATCH /api/v1/comments/:id
 *   DELETE /api/v1/comments/:id
 */

// GET comments for a task
router.get(
  "/tasks/:taskId/comments",
  verifyTaskAccess("view"),
  commentController.getCommentsByTask
);

// POST add a comment
router.post(
  "/tasks/:taskId/comments",
  verifyTaskAccess("view"),
  validate(addCommentSchema),
  commentController.addComment
);

// PATCH edit comment (author only)
router.patch(
  "/comments/:id",
  verifyCommentOwnership,
  validate(updateCommentSchema),
  commentController.updateComment
);

// DELETE comment (author / admin / superadmin)
router.delete("/comments/:id", verifyCommentOwnership, commentController.deleteComment);

module.exports = router;
