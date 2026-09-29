const crypto = require("crypto");
const { z } = require("zod");
const config = require("../config/env");

/**
 * Password-derived key scheme (same algorithm as frontend/lib/crypto/passwordKeys.ts):
 *
 *   master  = PBKDF2-SHA256(password, salt, iterations, 32 bytes)
 *   authKey = HKDF-SHA256(master, salt = empty, info = "bonito-auth-v1", 32 bytes)  → sent to the server
 *   wrapKey = HKDF-SHA256(master, salt = empty, info = "bonito-wrap-v1", 32 bytes)  → stays in the browser
 *
 * The server stores bcrypt(authKey), so it never sees the password and cannot
 * compute the wrapKey that protects the user's chat keys.
 */
const KDF_ALGORITHM = "PBKDF2-SHA256";
const KDF_ITERATIONS = 600000; // OWASP 2023 recommendation for PBKDF2-SHA256
const SALT_BYTES = 16;
const KEY_BYTES = 32;

const b64Bytes = (bytes) =>
  z
    .string()
    .max(128)
    .regex(/^[A-Za-z0-9+/]+={0,2}$/, "Invalid encoding")
    .refine((v) => Buffer.from(v, "base64").length === bytes, `Must be ${bytes} bytes`);

const authKeySchema = b64Bytes(KEY_BYTES);
const saltSchema = b64Bytes(SALT_BYTES);

const newSalt = () => crypto.randomBytes(SALT_BYTES).toString("base64");

const kdfParams = (salt) => ({ algorithm: KDF_ALGORITHM, iterations: KDF_ITERATIONS, salt });

/**
 * Deterministic fake salt for identifiers with no account, so /auth/prelogin
 * answers the same way for known and unknown emails/phones.
 */
const fakeSalt = (identifier) =>
  crypto
    .createHmac("sha256", config.otpHmacSecret)
    .update(`prelogin:${String(identifier).trim().toLowerCase()}`)
    .digest()
    .subarray(0, SALT_BYTES)
    .toString("base64");

/** Server-side derivation — used only by scripts (seed) and tests. */
const deriveAuthKey = (password, saltB64, iterations = KDF_ITERATIONS) => {
  const master = crypto.pbkdf2Sync(password, Buffer.from(saltB64, "base64"), iterations, KEY_BYTES, "sha256");
  return Buffer.from(crypto.hkdfSync("sha256", master, Buffer.alloc(0), "bonito-auth-v1", KEY_BYTES)).toString("base64");
};

module.exports = {
  KDF_ALGORITHM,
  KDF_ITERATIONS,
  authKeySchema,
  saltSchema,
  newSalt,
  kdfParams,
  fakeSalt,
  deriveAuthKey
};
