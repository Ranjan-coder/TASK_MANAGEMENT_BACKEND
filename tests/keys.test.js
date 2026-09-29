process.env.NODE_ENV = "test";

const crypto = require("crypto");
const mongoose = require("mongoose");
const { deriveAuthKey, fakeSalt, newSalt, authKeySchema, KDF_ITERATIONS } = require("../src/utils/kdf");
const Conversation = require("../src/models/Conversation");
const User = require("../src/models/User");
const groupKeys = require("../src/services/groupKeys.service");

describe("password-derived authKey", () => {
  test("matches the WebCrypto derivation used in the browser", async () => {
    const password = "Bonito2026Secure";
    const salt = newSalt();
    const subtle = globalThis.crypto.subtle;

    // Same steps as frontend/lib/crypto/passwordKeys.ts
    const base = await subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
    const master = await subtle.deriveBits(
      { name: "PBKDF2", hash: "SHA-256", salt: Buffer.from(salt, "base64"), iterations: KDF_ITERATIONS },
      base,
      256
    );
    const hkdf = await subtle.importKey("raw", master, "HKDF", false, ["deriveBits"]);
    const authBits = await subtle.deriveBits(
      { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: new TextEncoder().encode("bonito-auth-v1") },
      hkdf,
      256
    );

    expect(Buffer.from(authBits).toString("base64")).toBe(deriveAuthKey(password, salt));
  }, 30000);

  test("is 32 bytes, salt-dependent, and never equals the password", () => {
    const salt = newSalt();
    const key = deriveAuthKey("Secure123", salt, 1000);
    expect(authKeySchema.safeParse(key).success).toBe(true);
    expect(key).not.toContain("Secure123");
    expect(deriveAuthKey("Secure123", newSalt(), 1000)).not.toBe(key);
  });

  test("fake salts are stable per identifier and look like real ones", () => {
    expect(fakeSalt("nobody@example.com")).toBe(fakeSalt("NOBODY@example.com "));
    expect(fakeSalt("a@example.com")).not.toBe(fakeSalt("b@example.com"));
    expect(Buffer.from(fakeSalt("x@example.com"), "base64")).toHaveLength(16);
  });
});

describe("User credential helpers", () => {
  test("verifyCredential uses the authKey for derived accounts and the password for legacy ones", async () => {
    const bcrypt = require("bcryptjs");
    const authKey = crypto.randomBytes(32).toString("base64");

    const derived = new User({ name: "D", email: "d@example.com", authScheme: "derived", password: await bcrypt.hash(authKey, 4) });
    expect(await derived.verifyCredential({ authKey })).toBe(true);
    expect(await derived.verifyCredential({ password: authKey })).toBe(false);

    const legacy = new User({ name: "L", email: "l@example.com", password: await bcrypt.hash("Old123pass", 4) });
    expect(await legacy.verifyCredential({ password: "Old123pass", authKey })).toBe(true);
    expect(await legacy.verifyCredential({ authKey })).toBe(false);
  });

  test("setDerivedCredential records the scheme and KDF parameters", () => {
    const u = new User({ name: "N", email: "n@example.com" });
    const salt = newSalt();
    u.setDerivedCredential(crypto.randomBytes(32).toString("base64"), salt);
    expect(u.authScheme).toBe("derived");
    expect(u.kdf.salt).toBe(salt);
    expect(u.kdf.iterations).toBe(KDF_ITERATIONS);
  });
});

describe("group key rules", () => {
  const a = new mongoose.Types.ObjectId();
  const b = new mongoose.Types.ObjectId();
  const outsider = new mongoose.Types.ObjectId();
  const wrapped = "AAAAAAAAAAAAAAAA:" + "B".repeat(64);
  const entry = (extra = {}) => ({ wrapped, wrapperKeyVersion: 1, recipientKeyVersion: 1, ...extra });

  test("initial keyring only accepts members and well-formed entries", () => {
    const ring = groupKeys.buildInitialKeyring({
      keys: { [a]: entry(), [b]: entry() },
      creatorId: a,
      memberIdList: [a, b]
    });
    expect(ring[0].version).toBe(1);
    expect(ring[0].keys.get(String(b)).wrappedBy).toBe(a);

    expect(() =>
      groupKeys.buildInitialKeyring({ keys: { [outsider]: entry() }, creatorId: a, memberIdList: [a, b] })
    ).toThrow();
    expect(() =>
      groupKeys.buildInitialKeyring({ keys: { [a]: entry({ wrapped: "<script>" }) }, creatorId: a, memberIdList: [a, b] })
    ).toThrow();
  });

  test("message keyRef must match the conversation type and a known version", () => {
    const group = new Conversation({
      type: "group",
      createdBy: a,
      members: [{ user: a }, { user: b }],
      groupKeyring: [{ version: 1, keys: {} }, { version: 2, keys: {} }]
    });
    expect(groupKeys.parseKeyRef({ g: 2 }, group)).toEqual({ g: 2 });
    expect(groupKeys.parseKeyRef(undefined, group)).toBeUndefined();
    expect(() => groupKeys.parseKeyRef({ g: 3 }, group)).toThrow();
    expect(() => groupKeys.parseKeyRef({ s: 1, r: 1 }, group)).toThrow();
    expect(() => groupKeys.parseKeyRef({ g: -1 }, group)).toThrow();

    const dm = new Conversation({ type: "dm", createdBy: a, members: [{ user: a }, { user: b }] });
    expect(groupKeys.parseKeyRef({ s: 2, r: 5 }, dm)).toEqual({ s: 2, r: 5 });
    expect(() => groupKeys.parseKeyRef({ g: 1 }, dm)).toThrow();
    expect(() => groupKeys.parseKeyRef({ s: 1 }, dm)).toThrow();
  });
});
