/**
 * Lists privileged accounts (superadmin/admin/marketing) so they can be reviewed
 * after closing the public-registration role hole. Accounts with no `createdBy`
 * were either self-registered through the old /auth/register (which accepted a
 * `role` field) or created by a seed script — review every one of them.
 *
 * Read-only. Usage: npm run audit:privileged
 */
const mongoose = require("mongoose");
const connectDB = require("../src/config/db");
const User = require("../src/models/User");
const AuditLog = require("../src/models/AuditLog");
const { PRIVILEGED_ROLES } = require("../src/config/roles");

const main = async () => {
  await connectDB();

  const users = await User.find({ role: { $in: PRIVILEGED_ROLES } })
    .select("name email role status createdBy createdAt isTwoFactorEnabled lastLogin")
    .populate("createdBy", "email")
    .sort({ createdAt: 1 })
    .lean();

  const selfRegistered = await AuditLog.find({ action: "user_registered", actor: null })
    .select("targetId")
    .lean();
  const selfRegisteredIds = new Set(selfRegistered.map((l) => String(l.targetId)));

  const seeded = await AuditLog.find({ action: "seed_admin_created" }).select("targetId").lean();
  const seededIds = new Set(seeded.map((l) => String(l.targetId)));

  const rows = users.map((u) => {
    let origin = u.createdBy ? `created by ${u.createdBy.email}` : "no creator recorded";
    if (seededIds.has(String(u._id))) origin = "seed script";
    else if (selfRegisteredIds.has(String(u._id)) || !u.createdBy) origin = "SELF-REGISTERED? review";
    return {
      email: u.email,
      role: u.role,
      status: u.status,
      "2FA": u.isTwoFactorEnabled ? "on" : "OFF",
      created: new Date(u.createdAt).toISOString().slice(0, 10),
      lastLogin: u.lastLogin ? new Date(u.lastLogin).toISOString().slice(0, 10) : "never",
      origin
    };
  });

  console.table(rows);
  const flagged = rows.filter((r) => r.origin.startsWith("SELF")).length;
  console.log(`${rows.length} privileged account(s); ${flagged} need review.`);
  if (flagged) {
    console.log("To demote one: log in as superadmin → Users → change role, or suspend it.");
  }
};

main()
  .catch((err) => {
    console.error(`Audit failed: ${err.message}`);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
