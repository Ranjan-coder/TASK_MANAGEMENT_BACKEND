/**
 * Creates the product owner (platform_owner) account from environment variables.
 * This role sits above every organisation and can only be created here: no
 * screen or API can assign it.
 *
 *   PLATFORM_OWNER_EMAIL=owner@example.com
 *   PLATFORM_OWNER_PASSWORD=<initial password>
 *   PLATFORM_OWNER_NAME="Product Owner"      (optional)
 *
 * Usage:
 *   node scripts/seedPlatformOwner.js            create the account if it does not exist
 *   node scripts/seedPlatformOwner.js --reset    reset its password
 *
 * The account must change the password at first sign-in and needs 2FA (it is a
 * privileged role). Sign in with the reserved organisation code "platform".
 */
const mongoose = require("mongoose");
const connectDB = require("../src/config/db");
const User = require("../src/models/User");
const AuditLog = require("../src/models/AuditLog");
const { PLATFORM_OWNER } = require("../src/config/roles");
const { passwordPolicy } = require("../src/validators/auth.validator");
const { newSalt, deriveAuthKey } = require("../src/utils/kdf");
const { runAsPlatform, runAsSystem } = require("../src/utils/tenantContext");

const setPassword = (user, password) => {
  const salt = newSalt();
  user.setDerivedCredential(deriveAuthKey(password, salt), salt);
};

const main = async () => {
  const email = (process.env.PLATFORM_OWNER_EMAIL || "").trim().toLowerCase();
  const password = process.env.PLATFORM_OWNER_PASSWORD || "";
  const name = (process.env.PLATFORM_OWNER_NAME || "Product Owner").trim();
  const reset = process.argv.includes("--reset");

  if (!email || !password) throw new Error("PLATFORM_OWNER_EMAIL and PLATFORM_OWNER_PASSWORD must be set in backend/.env");
  const check = passwordPolicy.safeParse(password);
  if (!check.success) throw new Error(`PLATFORM_OWNER_PASSWORD is too weak: ${check.error.errors.map((e) => e.message).join("; ")}`);

  await connectDB();

  const inOrgs = await runAsSystem(() => User.countDocuments({ email, orgId: { $ne: null } }));
  if (inOrgs) {
    console.warn(`WARNING: ${email} also has ${inOrgs} organisation account(s). Use a separate address for the product owner.`);
  }

  await runAsPlatform(async () => {
    let user = await User.findOne({ email });
    let action = "already exists (unchanged; pass --reset to reset the password)";
    if (!user) {
      user = new User({ name, email, role: PLATFORM_OWNER, isEmailVerified: true, mustChangePassword: true });
      setPassword(user, password);
      await user.save();
      action = "created";
    } else if (reset) {
      setPassword(user, password);
      user.keyBundle = undefined;
      user.mustChangePassword = true;
      user.tokenVersion += 1;
      user.failedLoginAttempts = 0;
      user.lockUntil = undefined;
      await user.save();
      action = "password reset";
    }
    if (action !== "already exists (unchanged; pass --reset to reset the password)") {
      await AuditLog.create({
        actor: user._id,
        action: action === "created" ? "platform_owner_created" : "platform_owner_password_reset",
        targetType: "User",
        targetId: user._id,
        metadata: { email, source: "scripts/seedPlatformOwner.js" }
      });
    }
    console.log(`Product owner ${email}: ${action}. Sign in with the organisation code "platform".`);
  });
};

main()
  .catch((err) => {
    console.error(`Seed failed: ${err.message}`);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
