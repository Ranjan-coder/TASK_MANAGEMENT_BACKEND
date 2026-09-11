const Notification = require("../models/Notification");
const { getIO } = require("../sockets");

const sendNotification = async ({ recipient, sender, type, title, message, relatedTask, relatedComment }) => {
  const notification = await Notification.create({
    recipient,
    sender,
    type,
    title,
    message,
    relatedTask,
    relatedComment
  });

  const io = getIO();
  if (io) {
    io.to(`user:${recipient}`).emit("notification:new", notification);
  }

  return notification;
};

module.exports = {
  sendNotification
};
