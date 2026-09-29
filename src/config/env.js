const dotenv = require("dotenv");
dotenv.config();

const config = {
  env: process.env.NODE_ENV || "development",
  port: parseInt(process.env.PORT, 10) || 5000,
  mongoUri: process.env.MONGO_URI || "mongodb://localhost:27017/taskmanager",
  redisUrl: process.env.REDIS_URL || "redis://localhost:6379",
  jwt: {
    accessSecret: process.env.JWT_ACCESS_SECRET || "default_access_secret_change_in_prod",
    refreshSecret: process.env.JWT_REFRESH_SECRET || "default_refresh_secret_change_in_prod",
    accessExpiry: process.env.JWT_ACCESS_EXPIRY || "15m",
    refreshExpiry: process.env.JWT_REFRESH_EXPIRY || "7d"
  },
  twoFactorEncryptionKey: process.env.TWO_FACTOR_ENCRYPTION_KEY || "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  cloudinary: {
    cloudName: process.env.CLOUDINARY_CLOUD_NAME,
    apiKey: process.env.CLOUDINARY_API_KEY,
    apiSecret: process.env.CLOUDINARY_API_SECRET
  },
  sms: {
    // "console" prints OTPs to the server log (development only); "msg91" sends real SMS
    provider: (process.env.SMS_PROVIDER || "console").toLowerCase(),
    msg91AuthKey: process.env.MSG91_AUTH_KEY,
    msg91OtpTemplateId: process.env.MSG91_OTP_TEMPLATE_ID
  },
  otpHmacSecret: process.env.OTP_HMAC_SECRET || "dev_only_otp_hmac_secret_change_in_prod",
  push: {
    publicKey: process.env.VAPID_PUBLIC_KEY || "",
    privateKey: process.env.VAPID_PRIVATE_KEY || "",
    subject: process.env.VAPID_SUBJECT || "mailto:admin@bonito.in"
  },
  // "Your designer replied" alerts by WhatsApp/SMS for customers who opted in
  alerts: {
    provider: (process.env.ALERT_PROVIDER || "console").toLowerCase(),
    msg91WhatsappNumber: process.env.MSG91_WHATSAPP_NUMBER || "",
    msg91WhatsappTemplate: process.env.MSG91_WHATSAPP_TEMPLATE || "",
    msg91SmsTemplateId: process.env.MSG91_ALERT_SMS_TEMPLATE_ID || ""
  },
  // Signs message-franking commitments so reported chat messages can be verified
  frankingSecret: process.env.FRANKING_SECRET || "dev_only_franking_secret_change_in_prod",
  privacyPolicyVersion: process.env.PRIVACY_POLICY_VERSION || "2026-09-28",
  clientUrl: process.env.CLIENT_URL || "http://localhost:3000",
  cookieDomain: process.env.COOKIE_DOMAIN || "localhost"
};

// Refuse to boot in production with missing or placeholder secrets
if (config.env === "production") {
  const insecure = [];
  const secret = (name, value) => {
    if (!value || value.length < 32 || /default|change_in_prod|super_secret|0123456789abcdef/i.test(value)) {
      insecure.push(name);
    }
  };
  secret("JWT_ACCESS_SECRET", process.env.JWT_ACCESS_SECRET);
  secret("JWT_REFRESH_SECRET", process.env.JWT_REFRESH_SECRET);
  secret("TWO_FACTOR_ENCRYPTION_KEY", process.env.TWO_FACTOR_ENCRYPTION_KEY);
  secret("OTP_HMAC_SECRET", process.env.OTP_HMAC_SECRET);
  secret("FRANKING_SECRET", process.env.FRANKING_SECRET);
  if (config.alerts.provider === "console") {
    insecure.push("ALERT_PROVIDER=console is development-only (use msg91 or none)");
  }
  if (config.alerts.provider === "msg91" && (!config.sms.msg91AuthKey || (!config.alerts.msg91WhatsappTemplate && !config.alerts.msg91SmsTemplateId))) {
    insecure.push("ALERT_PROVIDER=msg91 needs MSG91_AUTH_KEY and a WhatsApp template or MSG91_ALERT_SMS_TEMPLATE_ID");
  }
  if (!config.push.publicKey || !config.push.privateKey) {
    insecure.push("VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY are required (web push)");
  }
  if (config.sms.provider === "console") {
    insecure.push("SMS_PROVIDER=console is development-only (would print OTPs to logs)");
  }
  if (config.sms.provider === "msg91" && (!config.sms.msg91AuthKey || !config.sms.msg91OtpTemplateId)) {
    insecure.push("MSG91_AUTH_KEY and MSG91_OTP_TEMPLATE_ID are required when SMS_PROVIDER=msg91");
  }
  if (process.env.JWT_ACCESS_SECRET && process.env.JWT_ACCESS_SECRET === process.env.JWT_REFRESH_SECRET) {
    insecure.push("JWT_ACCESS_SECRET must differ from JWT_REFRESH_SECRET");
  }
  if (insecure.length) {
    throw new Error(`Insecure production configuration: ${insecure.join(", ")}`);
  }
}

module.exports = config;
