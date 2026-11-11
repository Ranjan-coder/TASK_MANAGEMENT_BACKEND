/**
 * One-time move to multiple organisations (module-access-plan.md, Phase 1).
 *
 *   node scripts/migrateTenancy.js          preview only (nothing is written)
 *   node scripts/migrateTenancy.js --apply  write the changes
 *
 * 1. Creates the first organisation (TENANT_DEFAULT_SLUG, default "bonito";
 *    TENANT_DEFAULT_NAME, default "Bonito") if it doesn't exist.
 * 2. Gives every document without an orgId, in every organisation-scoped
 *    collection, that organisation's id.
 * 3. Renames sequence counters to "<orgId>:<name>".
 * 4. Rebuilds the indexes: unique values (email, phone, ticket numbers, …) become
 *    unique per organisation instead of across the whole database.
 *
 * Safe to run again: only documents without an orgId are touched.
 */
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");
require("../src/config/db"); // DNS settings for Atlas in development
const Organisation = require("../src/models/Organisation");
const { Counter } = require("../src/models/Counter");
const { runAsSystem } = require("../src/utils/tenantContext");

const APPLY = process.argv.includes("--apply");
const SLUG = (process.env.TENANT_DEFAULT_SLUG || "bonito").trim().toLowerCase();
const NAME = (process.env.TENANT_DEFAULT_NAME || "Bonito").trim();

// Load every model so mongoose.models is complete: src/models and each packaged
// module's models folder (src/modules/*/models)
const loadModels = (dir) => {
  if (!fs.existsSync(dir)) return;
  for (const f of fs.readdirSync(dir)) if (f.endsWith(".js")) require(path.join(dir, f));
};
loadModels(path.join(__dirname, "../src/models"));
const modulesDir = path.join(__dirname, "../src/modules");
for (const m of fs.readdirSync(modulesDir, { withFileTypes: true })) if (m.isDirectory()) loadModels(path.join(modulesDir, m.name, "models"));

const tenantModels = () => Object.values(mongoose.models).filter((m) => m.schema.path("orgId"));
const MISSING = { $or: [{ orgId: { $exists: false } }, { orgId: null }] };

const main = async () => {
  // autoIndex off: the old unique indexes are replaced in step 4, not on connect
  await mongoose.connect(process.env.MONGO_URI, { autoIndex: false, serverSelectionTimeoutMS: 10000 });
  console.log(APPLY ? "APPLYING changes\n" : "PREVIEW (nothing is written; pass --apply to write)\n");

  // 1. First organisation
  let org = await Organisation.findOne({ slug: SLUG });
  if (!org) {
    console.log(`Organisation "${NAME}" (${SLUG}) will be created.`);
    if (APPLY) org = await Organisation.create({ name: NAME, slug: SLUG });
  } else {
    console.log(`Organisation "${org.name}" (${org.slug}) exists: ${org._id}`);
  }
  const orgId = org?._id || new mongoose.Types.ObjectId(); // placeholder id in preview

  // The first organisation keeps everything it already used: every module on (Phase 2)
  if (!org?.modules?.length) {
    const { TOGGLEABLE_KEYS } = require("../src/config/modules");
    console.log(`Modules for "${NAME}": all ${TOGGLEABLE_KEYS.length} switched on.`);
    if (APPLY && org) {
      await Organisation.updateOne(
        { _id: org._id },
        { $set: { modules: TOGGLEABLE_KEYS.map((key) => ({ key, enabled: true, expiresAt: null, seatLimit: null, updatedAt: new Date() })) }, $inc: { entitlementVersion: 1 } }
      );
    }
  }

  // 2. Backfill orgId (raw collection calls: the tenant hooks would otherwise filter).
  //    Platform-level documents rightly have no organisation and are never touched:
  //    the product owner's account and the platform audit trail (orgId null by design).
  const ownerIds = (await mongoose.connection.db.collection("users").find({ role: "platform_owner" }).project({ _id: 1 }).toArray()).map((u) => u._id);
  const PLATFORM_LEVEL = {
    User: { role: { $ne: "platform_owner" } },
    AuditLog: { action: { $not: /^platform_/ }, actor: { $nin: ownerIds } }
  };
  console.log("\nDocuments without an organisation:");
  for (const Model of tenantModels()) {
    const filter = { $and: [MISSING, PLATFORM_LEVEL[Model.modelName] || {}] };
    const n = await Model.collection.countDocuments(filter);
    if (!n) continue;
    console.log(`  ${Model.modelName.padEnd(20)} ${n}`);
    if (APPLY) await Model.collection.updateMany(filter, { $set: { orgId } });
  }

  // 3. Counters "name" → "<orgId>:name"
  const counters = await Counter.collection.find({ _id: { $not: /:/ } }).toArray();
  for (const c of counters) {
    console.log(`  Counter "${c._id}" → "${orgId}:${c._id}" (seq ${c.seq})`);
    if (APPLY) {
      await Counter.collection.updateOne({ _id: `${orgId}:${c._id}` }, { $max: { seq: c.seq } }, { upsert: true });
      await Counter.collection.deleteOne({ _id: c._id });
    }
  }

  // 4. Indexes
  console.log("\nIndex changes:");
  // Every model, not only organisation-scoped ones (e.g. UsedStepToken's unique jti,
  // which single-use tokens depend on; production does not build indexes on start)
  for (const Model of Object.values(mongoose.models)) {
    let diff;
    try {
      diff = await Model.diffIndexes();
    } catch (err) {
      if (err.codeName === "NamespaceNotFound") continue; // collection not created yet
      throw err;
    }
    const drop = diff.toDrop.filter((n) => n !== "_id_");
    const create = diff.toCreate.map((spec) => JSON.stringify(spec.key || spec));
    if (!drop.length && !create.length) continue;
    console.log(`  ${Model.modelName}: drop [${drop.join(", ")}] create [${create.join(", ")}]`);
    if (APPLY) await Model.syncIndexes();
  }

  // 5. Phase 4: staff who existed before per-person modules keep everything they
  //    could use (admins and superadmins already do by role), then seats are counted
  const User = mongoose.model("User");
  const legacy = { role: { $in: ["user", "marketing", "leadership"] }, "moduleAccess.all": { $in: [null] } };
  const legacyCount = await User.collection.countDocuments(legacy);
  if (legacyCount) console.log(`\nStaff keeping every module (set before per-person access): ${legacyCount}`);
  if (APPLY) {
    if (legacyCount) await User.collection.updateMany(legacy, { $set: { "moduleAccess.all": true, "moduleAccess.version": 0 } });
    const { runInOrg } = require("../src/utils/tenantContext");
    const { recountSeats } = require("../src/services/moduleAccess.service");
    for (const o of await Organisation.find().select("_id slug").lean()) {
      const counts = await runInOrg(o._id, () => recountSeats());
      console.log(`  Seats counted for ${o.slug}: ${[...counts].filter(([, n]) => n).map(([k, n]) => `${k} ${n}`).join(", ") || "none"}`);
    }
  }

  console.log(APPLY ? "\nDone." : "\nPreview finished. Run again with --apply to write.");
};

runAsSystem(main)
  .catch((err) => {
    console.error(`Migration failed: ${err.message}`);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
