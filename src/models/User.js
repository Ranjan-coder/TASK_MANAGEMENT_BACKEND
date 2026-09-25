const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");

const sessionSchema = new mongoose.Schema({
  sessionId: { type: String, required: true },
  device: { type: String, default: "Unknown Device" },
  ipAddress: { type: String, default: "Unknown IP" },
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
      enum: ["superadmin", "admin", "user"],
      default: "user"
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

userSchema.pre("save", async function (next) {
  if (!this.isModified("password")) return next();
  this.password = await bcrypt.hash(this.password, 12);
  this.passwordChangedAt = Date.now() - 1000;
  next();
});

userSchema.methods.comparePassword = async function (candidatePassword) {
  return await bcrypt.compare(candidatePassword, this.password);
};

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
  if (this.failedLoginAttempts + 1 >= 5 && !this.isLocked()) {
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

const User = mongoose.model("User", userSchema);
module.exports = User;
