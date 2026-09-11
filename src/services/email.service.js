const nodemailer = require("nodemailer");
const logger = require("../utils/logger");

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || "smtp.mailtrap.io",
  port: parseInt(process.env.SMTP_PORT, 10) || 2525,
  auth: {
    user: process.env.SMTP_USER || "",
    pass: process.env.SMTP_PASS || ""
  }
});

const sendEmail = async ({ to, subject, html }) => {
  try {
    if (process.env.NODE_ENV === "test") return;
    const info = await transporter.sendMail({
      from: process.env.EMAIL_FROM || '"Task Manager" <noreply@yourorg.com>',
      to,
      subject,
      html
    });
    logger.info(`Email sent to ${to}: ${info.messageId}`);
    return info;
  } catch (error) {
    logger.error(`Failed to send email to ${to}: ${error.message}`);
  }
};

module.exports = { sendEmail };
