const express = require("express");
const router = express.Router();

const notificationController = require("../controllers/notification.controller");
const authMiddleware = require("../middlewares/auth.middleware");

router.use(authMiddleware);

// GET all notifications for current user
router.get("/", notificationController.getMyNotifications);

// PATCH mark all as read
router.patch("/read-all", notificationController.markAllAsRead);

// PATCH mark one as read
router.patch("/:id/read", notificationController.markAsRead);

// DELETE one notification
router.delete("/:id", notificationController.deleteNotification);

module.exports = router;
