const Notification = require("../models/Notification");
const { getIO } = require("../sockets");

const sendNotification = async ({ recipient, sender, type, title, message, relatedTask, relatedComment, relatedConversation }) => {
  const notification = await Notification.create({
    recipient,
    sender,
    type,
    title,
    message,
    relatedTask,
    relatedComment,
    relatedConversation
  });

  const io = getIO();
  if (io) {
    io.to(`user:${recipient}`).emit("notification:new", notification);
  }

  // Also to the person's phone/desktop if they installed the app and allowed notifications
  const push = require("./push.service");
  if (push.configured) {
    push
      .sendToUser(recipient, { title, body: message, url: push.urlForNotification(notification), tag: String(notification._id) })
      .catch(() => {});
  }

  return notification;
};

module.exports = {
  sendNotification
};
