const mongoose = require("mongoose");

/**
 * An end-to-end encrypted value (planner-module-plan.md): AES-256-GCM ciphertext
 * and its 12-byte IV, both base64. The server only stores and returns these; it
 * has no key and never sees the text.
 */
const B64 = /^[A-Za-z0-9+/]+={0,2}$/;
const IV_B64 = /^[A-Za-z0-9+/]{16}$/; // 12 bytes

const encryptedSchema = (maxBytes) =>
  new mongoose.Schema(
    {
      ciphertext: { type: String, required: true, maxlength: Math.ceil((maxBytes * 4) / 3) + 4, match: B64 },
      iv: { type: String, required: true, match: IV_B64 }
    },
    { _id: false }
  );

module.exports = { encryptedSchema, B64, IV_B64 };
