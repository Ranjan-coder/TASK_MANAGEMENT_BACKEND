/**
 * Indian mobile number helpers. Only +91 mobile numbers (starting 6-9) are
 * accepted, which also blocks international SMS-pumping fraud.
 */

/**
 * Accepts "9876543210", "09876543210", "+91 98765 43210", "91-9876543210".
 * @returns {string|null} E.164 "+919876543210", or null if not a valid Indian mobile
 */
const normalizeIndianMobile = (input) => {
  if (typeof input !== "string") return null;
  const trimmed = input.trim();
  if (trimmed.length > 20 || !/^[+\d\s\-()]+$/.test(trimmed)) return null;

  let digits = trimmed.replace(/\D/g, "");
  if (digits.length === 12 && digits.startsWith("91")) digits = digits.slice(2);
  else if (digits.length === 11 && digits.startsWith("0")) digits = digits.slice(1);

  if (!/^[6-9]\d{9}$/.test(digits)) return null;
  return `+91${digits}`;
};

/** "+919876543210" -> "+91 ******3210" (safe to show or log) */
const maskPhone = (e164) => {
  if (!e164 || e164.length < 4) return "";
  return `+91 ******${e164.slice(-4)}`;
};

const looksLikeEmail = (value) => typeof value === "string" && value.includes("@");

module.exports = { normalizeIndianMobile, maskPhone, looksLikeEmail };
