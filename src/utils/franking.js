const crypto = require("crypto");
const config = require("../config/env");

/**
 * Message franking (plan §4.2), as used for reports in end-to-end encrypted
 * messengers:
 *  - the sender's app picks a random 32-byte frankingKey, puts it inside the
 *    encrypted message, and sends commitment = HMAC-SHA256(frankingKey, text);
 *  - the server stores the commitment with serverTag = HMAC(serverSecret,
 *    commitment | conversation | sender | time);
 *  - a reporter reveals (text, frankingKey) for chosen messages only, and the
 *    server checks both HMACs. A fake or altered text can't match.
 */

const B64_32 = /^[A-Za-z0-9+/]{43}=$/; // base64 of exactly 32 bytes

const isCommitment = (v) => typeof v === "string" && B64_32.test(v);

const serverTagFor = ({ commitment, conversationId, senderId, serverTs }) =>
  crypto
    .createHmac("sha256", config.frankingSecret)
    .update(`bonito-frank-v1|${commitment}|${conversationId}|${senderId}|${new Date(serverTs).toISOString()}`)
    .digest("base64");

/** The franking record stored with a new or edited message (or undefined). */
const stampFranking = ({ commitment, conversationId, senderId, now = new Date() }) => {
  if (!isCommitment(commitment)) return undefined;
  return { commitment, serverTs: now, serverTag: serverTagFor({ commitment, conversationId, senderId, serverTs: now }) };
};

const safeEqual = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

/**
 * True if `text` + `frankingKey` (base64) is what `message`'s sender committed to.
 */
const verifyReveal = (message, { text, frankingKey }) => {
  const f = message?.franking;
  if (!f?.commitment || !f.serverTag || !f.serverTs) return false;
  if (typeof text !== "string" || typeof frankingKey !== "string" || !B64_32.test(frankingKey)) return false;
  const expectedTag = serverTagFor({
    commitment: f.commitment,
    conversationId: String(message.conversation),
    senderId: String(message.sender?._id || message.sender),
    serverTs: f.serverTs
  });
  if (!safeEqual(expectedTag, f.serverTag)) return false;
  const commitment = crypto.createHmac("sha256", Buffer.from(frankingKey, "base64")).update(text, "utf8").digest("base64");
  return safeEqual(commitment, f.commitment);
};

module.exports = { isCommitment, stampFranking, verifyReveal };
