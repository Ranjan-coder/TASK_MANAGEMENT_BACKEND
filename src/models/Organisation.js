const mongoose = require("mongoose");
const { TOGGLEABLE_KEYS, CUSTOMER_OPT_IN_KEYS } = require("../config/modules");

/**
 * A customer organisation (tenant) of the platform. Not tenant-scoped itself: it is
 * the thing tenancy is keyed on. Business data never lives here — only identity,
 * status and, from Phase 2, the modules the product owner has switched on.
 */
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/;
// Codes no organisation may take: "platform" signs the product owner in
const RESERVED_SLUGS = Object.freeze(["platform", "admin", "api", "www", "app", "login", "support"]);
const RESERVED_SLUGS_SET = new Set(RESERVED_SLUGS);
// Display name for branding: plain text only (no markup, no control characters)
const DISPLAY_NAME_RE = /^[^<>\u0000-\u001f\u007f]{2,60}$/;

// One module the product owner has set up for this organisation (config/modules.js).
// Kept as a small array: an organisation has at most a few dozen modules.
const moduleGrantSchema = new mongoose.Schema(
  {
    key: { type: String, enum: TOGGLEABLE_KEYS, required: true },
    enabled: { type: Boolean, default: true },
    // After this moment the module counts as off (checked when read, no sweeper needed)
    expiresAt: { type: Date, default: null },
    // How many people may be given this module (null = unlimited). Enforced in Phase 4.
    seatLimit: { type: Number, min: 1, max: 100000, default: null },
    updatedAt: { type: Date, default: Date.now },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null }
  },
  { _id: false }
);

const organisationSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },
    // Typed at every sign-in (D-R1) and used in invite links (/login?org=<slug>)
    slug: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      match: SLUG_RE,
      validate: { validator: (v) => !RESERVED_SLUGS_SET.has(v), message: "That organisation code is reserved" }
    },
    status: { type: String, enum: ["active", "suspended"], default: "active" },
    // The name the organisation's people see instead of the product name, while the
    // product owner has the "branding" module switched on for it. Set by the product owner.
    displayName: { type: String, trim: true, match: DISPLAY_NAME_RE, default: null },
    // Bumped on every entitlement change; caches compare it (Phase 2)
    entitlementVersion: { type: Number, default: 0 },
    modules: { type: [moduleGrantSchema], default: [] },
    // Staff-only modules the organisation's superadmin opened to its customers
    customerModules: { type: [{ type: String, enum: CUSTOMER_OPT_IN_KEYS }], default: [] },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null }
  },
  { timestamps: true }
);

organisationSchema.index({ status: 1 });

const Organisation = mongoose.model("Organisation", organisationSchema);
module.exports = Organisation;
module.exports.SLUG_RE = SLUG_RE;
module.exports.DISPLAY_NAME_RE = DISPLAY_NAME_RE;
module.exports.RESERVED_SLUGS = RESERVED_SLUGS;
module.exports.PLATFORM_CODE = "platform";
