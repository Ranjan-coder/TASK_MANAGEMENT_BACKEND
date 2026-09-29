const mongoose = require("mongoose");
const bcrypt = require("../utils/bcrypt");
const { ALL_ROLES, ROLES } = require("../config/roles");

// One signed-in device. Each session owns exactly one refresh token (stored as
// a hash), so removing the session signs that device out immediately.
const sessionSchema = new mongoose.Schema({
  sessionId: { type: String, required: true },
  device: { type: String, default: "Unknown Device" }, // raw user agent
  deviceName: { type: String, default: "Unknown device" }, // e.g. "Chrome on Windows"
  ipAddress: { type: String, default: "Unknown IP" },
  refreshTokenHash: { type: String, default: null },
  // false = shared/office computer: short session, keys kept in memory only
  trusted: { type: Boolean, default: true },
  lastActive: { type: Date, default: Date.now },
  createdAt: { type: Date, default: Date.now }
});

const userSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, "Name is required"],
      trim: true,
      maxlength: 100
    },
    email: {
      type: String,
      required: [true, "Email is required"],
      unique: true,
      lowercase: true,
      trim: true,
      match: [/^\S+@\S+\.\S+$/, "Please use a valid email address"]
    },
    password: {
      type: String,
      required: [true, "Password is required"],
      minlength: 8,
      select: false
    },
    role: {
      type: String,
      enum: ALL_ROLES,
      default: ROLES.USER
    },
    avatarUrl: {
      type: String,
      default: ""
    },
    department: {
      type: String,
      default: "General"
    },
    designation: {
      type: String,
      default: "Staff"
    },
    status: {
      type: String,
      enum: ["active", "inactive", "suspended"],
      default: "active"
    },
    // Customers: opted-in "your designer replied" alerts outside the app
    twoFactorLastCode: { type: String, select: false, default: null },
    twoFactorStepJti: { type: String, default: null },
    notificationPrefs: {
      whatsapp: { type: Boolean, default: false },
      sms: { type: Boolean, default: false },
      updatedAt: { type: Date, default: null }
    },
    deletedAt: { type: Date, default: null },
    // Customers: their personal referral code (issued once the phone is verified)
    referralCode: { type: String, default: undefined },
    // Staff leave: reply-timer reminders go to the backup designer instead
    availability: {
      status: { type: String, enum: ["available", "on_leave"], default: "available" },
      until: { type: Date, default: null }
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null
    },
    lastLogin: {
      type: Date
    },
    refreshTokens: {
      type: [String],
      select: false,
      default: []
    },
    failedLoginAttempts: {
      type: Number,
      default: 0
    },
    lockUntil: {
      type: Date
    },
    passwordChangedAt: {
      type: Date
    },
    // Verified mobile number in E.164 (e.g. +919876543210). Only set after OTP
    // verification, so an unverified sign-up can never "reserve" someone's number.
    phone: {
      type: String,
      trim: true,
      default: undefined
    },
    phoneVerified: {
      type: Boolean,
      default: false
    },
    // Number entered at sign-up, waiting for OTP verification (not unique)
    pendingPhone: {
      type: String,
      trim: true,
      default: undefined,
      select: false
    },
    // DPDP Act consent record
    consent: {
      termsAcceptedAt: { type: Date, default: null },
      privacyVersion: { type: String, default: null }
    },
    // ── Password-derived keys (see utils/kdf.js) ──
    // The browser stretches the password with these parameters and splits the
    // result into an authKey (sent here instead of the password; stored as
    // bcrypt(authKey) in `password`) and a wrapKey that never leaves the device.
    kdf: {
      algorithm: { type: String, default: undefined },
      iterations: { type: Number, default: undefined },
      salt: { type: String, default: undefined }
    },
    // "legacy": `password` holds bcrypt(raw password) — migrated on next login
    authScheme: {
      type: String,
      enum: ["legacy", "derived"],
      default: undefined
    },
    // The user's chat private keys, encrypted in the browser with the wrapKey.
    // The server cannot decrypt this.
    keyBundle: {
      type: {
        ciphertext: { type: String, required: true },
        iv: { type: String, required: true },
        version: { type: Number, default: 1 },
        updatedAt: { type: Date, default: Date.now }
      },
      default: undefined,
      select: false,
      _id: false
    },
    // The same private keys, encrypted with a key derived from the user's
    // recovery key (shown to them once). Survives password resets.
    recoveryBundle: {
      type: {
        ciphertext: { type: String, required: true },
        iv: { type: String, required: true },
        updatedAt: { type: Date, default: Date.now }
      },
      default: undefined,
      select: false,
      _id: false
    },
    // Every public key the user has published, so old messages stay decryptable
    publicKeys: {
      type: [
        {
          version: { type: Number, required: true },
          publicKey: { type: String, required: true },
          createdAt: { type: Date, default: Date.now },
          _id: false
        }
      ],
      default: [],
      select: false
    },
    // Forces a password change before any non-auth route can be used (e.g. seeded accounts)
    mustChangePassword: {
      type: Boolean,
      default: false
    },
    passwordResetToken: {
      type: String,
      select: false
    },
    passwordResetExpires: {
      type: Date,
      select: false
    },
    isEmailVerified: {
      type: Boolean,
      default: false
    },
    // Security & 2FA Extensions
    isTwoFactorEnabled: {
      type: Boolean,
      default: false
    },
    twoFactorSecret: {
      type: String,
      select: false
    },
    twoFactorRecoveryCodes: {
      type: [{ code: String, used: { type: Boolean, default: false } }],
      select: false,
      default: []
    },
    tokenVersion: {
      type: Number,
      default: 0
    },
    currentSessions: [sessionSchema],

    // E2E Chat — ECDH public key (SPKI base64-exported, never the private key)
    publicKey: {
      type: String,
      default: null,
      select: true
    },
    keyVersion: {
      type: Number,
      default: 0
    },
    keyUpdatedAt: {
      type: Date,
      default: null
    }
  },
  {
    timestamps: true
  }
);

userSchema.index({ role: 1 });
userSchema.index({ status: 1 });
userSchema.index({ referralCode: 1 }, { unique: true, partialFilterExpression: { referralCode: { $type: "string" } } });
userSchema.index(
  { phone: 1 },
  { unique: true, partialFilterExpression: { phone: { $type: "string" } } }
);

userSchema.pre("save", async function (next) {
  if (!this.isModified("password")) return next();
  this.password = await bcrypt.hash(this.password, 12);
  this.passwordChangedAt = Date.now() - 1000;
  next();
});

userSchema.methods.comparePassword = async function (candidatePassword) {
  return await bcrypt.compare(candidatePassword, this.password);
};

/**
 * Checks login credentials for either scheme.
 * - derived: `password` field holds bcrypt(authKey)
 * - legacy:  `password` field holds bcrypt(raw password) — the client sends the
 *            raw password once, alongside the new authKey, to migrate.
 * Requires the document to be loaded with "+password".
 */
userSchema.methods.verifyCredential = async function ({ authKey, password }) {
  if (this.authScheme === "derived") {
    return typeof authKey === "string" && (await bcrypt.compare(authKey, this.password));
  }
  return typeof password === "string" && (await bcrypt.compare(password, this.password));
};

/** Stores a new password-derived credential (hashed by the pre-save hook). */
userSchema.methods.setDerivedCredential = function (authKey, salt) {
  const { kdfParams } = require("../utils/kdf");
  this.password = authKey;
  this.kdf = kdfParams(salt);
  this.authScheme = "derived";
};

// Per-network limits (5 tries per account per 15 min, see auth routes) stop one attacker;
// this account-wide lock only kicks in for guessing spread over many networks.
const ACCOUNT_LOCK_AFTER = 20;

userSchema.methods.isLocked = function () {
  return !!(this.lockUntil && this.lockUntil > Date.now());
};

userSchema.methods.incrementLoginAttempts = async function () {
  if (this.lockUntil && this.lockUntil < Date.now()) {
    return this.updateOne({
      $set: { failedLoginAttempts: 1 },
      $unset: { lockUntil: 1 }
    });
  }
  const updates = { $inc: { failedLoginAttempts: 1 } };
  if (this.failedLoginAttempts + 1 >= ACCOUNT_LOCK_AFTER && !this.isLocked()) {
    updates.$set = { lockUntil: Date.now() + 15 * 60 * 1000 }; // 15 min lock
  }
  return this.updateOne(updates);
};

userSchema.methods.resetLoginAttempts = async function () {
  return this.updateOne({
    $set: { failedLoginAttempts: 0 },
    $unset: { lockUntil: 1 }
  });
};

// Fields that must never leave the server in an API response (even if a query selects them)
const PRIVATE_FIELDS = [
  "password", "refreshTokens", "twoFactorSecret", "twoFactorRecoveryCodes", "twoFactorLastCode", "twoFactorStepJti",
  "failedLoginAttempts", "lockUntil", "tokenVersion", "authScheme", "kdf", "keyBundle", "recoveryBundle",
  "passwordResetToken", "passwordResetExpires", "pendingPhone", "__v"
];
userSchema.set("toJSON", {
  transform: (doc, ret) => {
    for (const f of PRIVATE_FIELDS) delete ret[f];
    // Sign-in sessions: only what the Devices screen needs, never token hashes
    if (Array.isArray(ret.currentSessions)) {
      ret.currentSessions = ret.currentSessions.map((s) => ({ sessionId: s.sessionId, deviceName: s.deviceName, lastActive: s.lastActive, createdAt: s.createdAt, trusted: s.trusted }));
    }
    return ret;
  }
});

const User = mongoose.model("User", userSchema);
module.exports = User;
