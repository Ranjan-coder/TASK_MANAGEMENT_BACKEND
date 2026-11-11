/**
 * Creates the Bonito monitoring account (superadmin) from environment variables.
 *
 *   SEED_ADMIN_EMAIL=admin@bonito.in
 *   SEED_ADMIN_PASSWORD=<initial password>
 *   SEED_ADMIN_NAME="Bonito Admin"        (optional)
 *   SEED_ORG_SLUG=bonito                  (optional) organisation the account belongs to;
 *   SEED_ORG_NAME="Bonito"                created if it doesn't exist
 *
 * Usage:
 *   npm run seed:admin              create the account if it does not exist
 *   npm run seed:admin -- --reset   reset its password to SEED_ADMIN_PASSWORD
 *
 * The account is flagged mustChangePassword, so the initial password only
 * works to reach the change-password screen. Credentials are never hardcoded.
 */
const mongoose = require("mongoose");
const connectDB = require("../src/config/db");
const User = require("../src/models/User");
const AuditLog = require("../src/models/AuditLog");
const { ROLES } = require("../src/config/roles");
const { passwordPolicy } = require("../src/validators/auth.validator");
const { newSalt, deriveAuthKey } = require("../src/utils/kdf");
const Organisation = require("../src/models/Organisation");
const { runInOrg, runAsSystem } = require("../src/utils/tenantContext");

// Same derivation the browser performs (utils/kdf.js), so the login page works
const setPassword = (user, password) => {
  const salt = newSalt();
  user.setDerivedCredential(deriveAuthKey(password, salt), salt);
};

const main = async () => {
  const email = (process.env.SEED_ADMIN_EMAIL || "").trim().toLowerCase();
  const password = process.env.SEED_ADMIN_PASSWORD || "";
  const name = (process.env.SEED_ADMIN_NAME || "Bonito Admin").trim();
  const reset = process.argv.includes("--reset");

  if (!email || !password) {
    throw new Error("SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD must be set in backend/.env");
  }
  const check = passwordPolicy.safeParse(password);
  if (!check.success) {
    throw new Error(`SEED_ADMIN_PASSWORD is too weak: ${check.error.errors.map((e) => e.message).join("; ")}`);
  }

  await connectDB(); // same DNS/Atlas settings as the app

  const slug = (process.env.SEED_ORG_SLUG || process.env.TENANT_DEFAULT_SLUG || "bonito").trim().toLowerCase();
  let org = await Organisation.findOne({ slug });
  if (!org) {
    org = await Organisation.create({ slug, name: (process.env.SEED_ORG_NAME || "Bonito").trim() });
    console.log(`Organisation "${org.name}" (${slug}) created.`);
  }
  // Everything below is scoped to that organisation
  await runInOrg(org._id, () => seedInOrg({ email, password, name, reset }));
};

const seedInOrg = async ({ email, password, name, reset }) => {

  let user = await User.findOne({ email });
  let action;
  let changed = true;

  if (!user) {
    // Department from the managed list (seeded on first use)
    const lists = await require("../src/services/org.service").load();
    const mgmt = lists.deptByKey.get(require("../src/utils/orgKey").orgKey("Management"));
    user = new User({
      name,
      email,
      role: ROLES.SUPERADMIN,
      ...(mgmt && { departmentId: mgmt._id, department: mgmt.name }),
      isEmailVerified: true,
      mustChangePassword: true
    });
    setPassword(user, password);
    await user.save();
    action = "created";
  } else if (reset) {
    setPassword(user, password);
    user.keyBundle = undefined;
    user.mustChangePassword = true;
    user.tokenVersion += 1; // sign out every existing session
    user.failedLoginAttempts = 0;
    user.lockUntil = undefined;
    await user.save();
    action = "password reset";
  } else {
    action = "already exists (unchanged; pass --reset to reset the password)";
    changed = false;
  }

  if (user.role !== ROLES.SUPERADMIN) {
    console.warn(`WARNING: ${email} exists with role "${user.role}", not superadmin. Change it deliberately if intended.`);
  }

  if (changed) {
    await AuditLog.create({
      actor: user._id,
      action: action === "created" ? "seed_admin_created" : "seed_admin_password_reset",
      targetType: "User",
      targetId: user._id,
      metadata: { email, source: "scripts/seedAdmin.js" }
    }).catch(() => {}); // audit schema differences must not block seeding
  }

  console.log(`Monitoring account ${email}: ${action}.`);
  if (changed) {
    console.log("The password must be changed at first login. Enable 2FA from Settings → Security.");
  }
};

runAsSystem(main)
  .catch((err) => {
    console.error(`Seed failed: ${err.message}`);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
