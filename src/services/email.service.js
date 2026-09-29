const nodemailer = require("nodemailer");
const logger = require("../utils/logger");

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || "smtp.mailtrap.io",
  port: parseInt(process.env.SMTP_PORT, 10) || 2525,
  auth: {
    user: process.env.SMTP_USER || "",
    pass: process.env.SMTP_PASS || ""
  },
  // Reuse connections and give up quickly: nodemailer's defaults (2 min connect,
  // 10 min socket) could hold a request open for minutes when SMTP is slow.
  pool: true,
  maxConnections: 3,
  connectionTimeout: 10000,
  greetingTimeout: 10000,
  socketTimeout: 20000
});

const sendEmail = async ({ to, subject, html }) => {
  try {
    if (process.env.NODE_ENV === "test") return;
    const info = await transporter.sendMail({
      from: process.env.EMAIL_FROM || '"Bonito Interiors" <noreply@bonito.in>',
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
