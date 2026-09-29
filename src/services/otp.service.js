const crypto = require("crypto");
const config = require("../config/env");
const OtpChallenge = require("../models/OtpChallenge");
const ApiError = require("../utils/ApiError");
const logger = require("../utils/logger");
const { maskPhone } = require("../utils/phone");
const { getSmsProvider } = require("./sms");

const OTP_TTL_SECONDS = 5 * 60;
const RESEND_COOLDOWN_SECONDS = 30;
const MAX_SENDS_PER_WINDOW = 3;
const SEND_WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const LOCK_MS = 15 * 60 * 1000;

const hashCode = (phone, purpose, code) =>
  crypto.createHmac("sha256", config.otpHmacSecret).update(`${purpose}:${phone}:${code}`).digest("hex");

const safeEqualHex = (a, b) => {
  const bufA = Buffer.from(a, "hex");
  const bufB = Buffer.from(b, "hex");
  return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);
};

const generateCode = () => String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");

const minutesLeft = (date) => Math.max(1, Math.ceil((date.getTime() - Date.now()) / 60000));

/**
 * Sends a new OTP to `phone`. Limits (per phone, across purposes): one send per
 * 30 s, three per 15 min, and no sends while locked after too many wrong codes.
 */
const sendOtp = async ({ phone, purpose, userId = null, ipAddress = "unknown" }) => {
  const now = new Date();
  const latest = await OtpChallenge.findOne({ phone }).sort({ createdAt: -1 });

  if (latest?.lockedUntil && latest.lockedUntil > now) {
    throw new ApiError(429, `Too many incorrect codes. Try again in ${minutesLeft(latest.lockedUntil)} min.`, [
      { code: "OTP_LOCKED" }
    ]);
  }

  if (latest && now - latest.createdAt < RESEND_COOLDOWN_SECONDS * 1000) {
    const wait = Math.ceil((RESEND_COOLDOWN_SECONDS * 1000 - (now - latest.createdAt)) / 1000);
    throw new ApiError(429, `Please wait ${wait} seconds before requesting another code.`, [
      { code: "OTP_COOLDOWN", resendAfterSeconds: wait }
    ]);
  }

  const recentSends = await OtpChallenge.countDocuments({
    phone,
    createdAt: { $gt: new Date(now.getTime() - SEND_WINDOW_MS) }
  });
  if (recentSends >= MAX_SENDS_PER_WINDOW) {
    throw new ApiError(429, "Too many codes requested. Please try again in 15 minutes.", [
      { code: "OTP_SEND_LIMIT" }
    ]);
  }

  const code = generateCode();
  const challenge = await OtpChallenge.create({
    phone,
    purpose,
    user: userId,
    codeHash: hashCode(phone, purpose, code),
    expiresAt: new Date(now.getTime() + OTP_TTL_SECONDS * 1000),
    ipAddress
  });

  try {
    await getSmsProvider().sendOtp(phone, code);
  } catch (err) {
    await OtpChallenge.deleteOne({ _id: challenge._id });
    logger.error(`OTP send to ${maskPhone(phone)} failed: ${err.message}`);
    throw new ApiError(503, "We couldn't send the SMS right now. Please try again shortly.", [
      { code: "SMS_UNAVAILABLE" }
    ]);
  }

  return { expiresInSeconds: OTP_TTL_SECONDS, resendAfterSeconds: RESEND_COOLDOWN_SECONDS };
};

const invalidCode = (remaining) =>
  new ApiError(400, "Invalid or expired code.", [
    { code: "OTP_INVALID", ...(remaining !== undefined ? { attemptsRemaining: remaining } : {}) }
  ]);

/**
 * Checks `code` against the latest unused OTP for this phone + purpose and
 * consumes it on success. Each attempt is counted atomically before comparing,
 * so parallel guesses cannot exceed MAX_ATTEMPTS.
 * @returns {Promise<import("mongoose").Document>} the consumed challenge
 */
const verifyOtp = async ({ phone, purpose, code }) => {
  if (typeof code !== "string" || !/^\d{6}$/.test(code)) throw invalidCode();

  const now = new Date();
  const latest = await OtpChallenge.findOne({ phone, purpose, consumedAt: null }).sort({ createdAt: -1 });
  if (!latest) throw invalidCode();

  if (latest.lockedUntil && latest.lockedUntil > now) {
    throw new ApiError(429, `Too many incorrect codes. Try again in ${minutesLeft(latest.lockedUntil)} min.`, [
      { code: "OTP_LOCKED" }
    ]);
  }

  const attempt = await OtpChallenge.findOneAndUpdate(
    { _id: latest._id, consumedAt: null, attempts: { $lt: MAX_ATTEMPTS }, expiresAt: { $gt: now } },
    { $inc: { attempts: 1 } },
    { new: true }
  );
  if (!attempt) throw invalidCode();

  if (!safeEqualHex(attempt.codeHash, hashCode(phone, purpose, code))) {
    const remaining = MAX_ATTEMPTS - attempt.attempts;
    if (remaining <= 0) {
      await OtpChallenge.updateOne({ _id: attempt._id }, { $set: { lockedUntil: new Date(Date.now() + LOCK_MS) } });
      throw new ApiError(429, "Too many incorrect codes. Try again in 15 min.", [{ code: "OTP_LOCKED" }]);
    }
    throw invalidCode(remaining);
  }

  const consumed = await OtpChallenge.findOneAndUpdate(
    { _id: attempt._id, consumedAt: null },
    { $set: { consumedAt: new Date() } },
    { new: true }
  );
  if (!consumed) throw invalidCode(); // already used by a concurrent request

  return consumed;
};

module.exports = {
  sendOtp,
  verifyOtp,
  // exported for tests
  _internals: { hashCode, generateCode, safeEqualHex, OTP_TTL_SECONDS, MAX_ATTEMPTS }
};
