const { authenticator } = require("otplib");
const qrcode = require("qrcode");
const crypto = require("crypto");
const config = require("../config/env");

authenticator.options = { window: 1 };

const algorithm = "aes-256-cbc";
const key = Buffer.from(config.twoFactorEncryptionKey.slice(0, 64), "hex");

const encryptSecret = (text) => {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(algorithm, key, iv);
  let encrypted = cipher.update(text, "utf8", "hex");
  encrypted += cipher.final("hex");
  return `${iv.toString("hex")}:${encrypted}`;
};

const decryptSecret = (encryptedText) => {
  const [ivHex, encrypted] = encryptedText.split(":");
  const iv = Buffer.from(ivHex, "hex");
  const decipher = crypto.createDecipheriv(algorithm, key, iv);
  let decrypted = decipher.update(encrypted, "hex", "utf8");
  decrypted += decipher.final("utf8");
  return decrypted;
};

const generate2FASecret = async (email) => {
  const secret = authenticator.generateSecret();
  const otpauth = authenticator.keyuri(email, "TaskManager", secret);
  const qrCodeUrl = await qrcode.toDataURL(otpauth);

  // Generate 8 backup recovery codes
  const rawCodes = [];
  const hashedCodes = [];
  for (let i = 0; i < 8; i++) {
    const code = crypto.randomBytes(4).toString("hex").toUpperCase();
    rawCodes.push(code);
    const hashed = crypto.createHash("sha256").update(code).digest("hex");
    hashedCodes.push({ code: hashed, used: false });
  }

  return {
    secret,
    encryptedSecret: encryptSecret(secret),
    qrCodeUrl,
    recoveryCodes: rawCodes,
    hashedCodes
  };
};

const verify2FAToken = (token, encryptedSecret) => {
  const secret = decryptSecret(encryptedSecret);
  return authenticator.verify({ token, secret });
};

module.exports = {
  generate2FASecret,
  verify2FAToken,
  encryptSecret,
  decryptSecret
};
