/**
 * One-time clean-up: links existing free-text departments / designations to the
 * managed lists (Tech / TECH / tech → Tech, "Chief Marketing Officer" → CMO …).
 *
 *   node scripts/migrateOrg.js          preview only (nothing is written)
 *   node scripts/migrateOrg.js --apply  write the changes
 *
 * Safe to run again: only users not yet linked are looked at. Values that match
 * nothing ("General", "Staff", "Manager" …) are cleared and listed, so a superadmin
 * can assign the right one in Users. Customers never keep a department or title.
 */
require("dotenv").config();
const mongoose = require("mongoose");
require("../src/config/db"); // DNS settings for Atlas in development
const User = require("../src/models/User");
const org = require("../src/services/org.service");
const { orgKey } = require("../src/utils/orgKey");

const APPLY = process.argv.includes("--apply");
// Placeholder values from the old free-text fields that mean "not set"
const EMPTY = new Set(["", "general", "staff", "customers", "customer", "na", "none"]);

const main = async () => {
  await mongoose.connect(process.env.MONGO_URI);
  const s = await org.load();
  // Designations also match by abbreviation ("GM", "BM", "GTM")
  const desigByShort = new Map(s.designations.filter((g) => g.short).map((g) => [orgKey(g.short), g]));

  const users = await User.find({
    $or: [
      { departmentId: null, department: { $nin: [null, ""] } },
      { designationId: null, designation: { $nin: [null, ""] } }
    ]
  })
    .select("name email role department designation departmentId designationId")
    .lean();

  const ops = [];
  const unmatched = [];
  for (const u of users) {
    const set = {};
    if (u.role === "customer") {
      Object.assign(set, { department: "", designation: "", departmentId: null, designationId: null });
    } else {
      if (!u.departmentId && u.department) {
        const k = orgKey(u.department);
        const d = EMPTY.has(k) ? null : s.deptByKey.get(k);
        if (d) Object.assign(set, { departmentId: d._id, department: d.name });
        else {
          set.department = "";
          if (!EMPTY.has(k)) unmatched.push(`${u.email}: department "${u.department}"`);
        }
      }
      if (!u.designationId && u.designation) {
        const k = orgKey(u.designation);
        const g = EMPTY.has(k) ? null : s.desigByKey.get(k) || desigByShort.get(k);
        if (g) Object.assign(set, { designationId: g._id, designation: g.name });
        else {
          set.designation = "";
          if (!EMPTY.has(k)) unmatched.push(`${u.email}: designation "${u.designation}"`);
        }
      }
    }
    console.log(`${u.email.padEnd(32)} ${`${u.department || "-"} / ${u.designation || "-"}`.padEnd(40)} → ${set.department ?? u.department ?? "-"} / ${set.designation ?? u.designation ?? "-"}`);
    ops.push({ updateOne: { filter: { _id: u._id }, update: { $set: set } } });
  }

  if (unmatched.length) {
    console.log("\nNo match (cleared — assign in Users):");
    for (const line of unmatched) console.log(`  ${line}`);
  }
  if (!ops.length) console.log("Nothing to migrate.");
  else if (APPLY) {
    const r = await User.bulkWrite(ops); // one round trip for every user
    console.log(`\nUpdated ${r.modifiedCount} user(s).`);
  } else console.log(`\nPreview only: ${ops.length} user(s) would change. Run with --apply to save.`);

  await mongoose.disconnect();
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
