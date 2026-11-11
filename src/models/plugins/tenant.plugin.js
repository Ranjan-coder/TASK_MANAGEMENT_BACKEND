const mongoose = require("mongoose");
const tenant = require("../../utils/tenantContext");

/**
 * Multi-tenant isolation for a schema (module-access-plan.md, Phase 1).
 *
 * Adds an immutable `orgId` and scopes every way Mongoose reaches the collection
 * to the current organisation (utils/tenantContext):
 *   - queries (find, update, delete, count, distinct): `{ orgId }` is ANDed into the filter
 *   - aggregate: a `$match: { orgId }` stage is put first
 *   - save / insertMany / bulkWrite inserts: orgId is filled in, or refused if it differs
 *   - bulkWrite updates and deletes: `{ orgId }` is ANDed into each filter
 * With no context a query throws (deny by default). In system context (jobs,
 * sign-in lookups, scripts) nothing is added, and new documents must carry orgId.
 *
 * Every index that has to be unique per organisation must start with orgId; the
 * schema's own index list is left to the model.
 */

const QUERY_OPS = [
  "find",
  "findOne",
  "countDocuments",
  "distinct",
  "findOneAndUpdate",
  "findOneAndReplace",
  "findOneAndDelete",
  "updateOne",
  "updateMany",
  "replaceOne",
  "deleteOne",
  "deleteMany"
];

const same = (a, b) => String(a) === String(b);

const mismatch = () => new tenant.TenantContextError("Document belongs to another organisation");

function tenantPlugin(schema, { required = true } = {}) {
  schema.add({
    orgId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Organisation",
      required,
      immutable: true,
      default: null
    }
  });
  schema.index({ orgId: 1 });

  // ── Queries ───────────────────────────────────────────────────────────────
  // Platform level (org null) matches only documents whose orgId IS null, never
  // ones missing the field (e.g. rows a migration hasn't reached)
  const match = (org) => (org === null ? { orgId: { $type: "null" } } : { orgId: org });

  schema.pre(QUERY_OPS, function () {
    const org = tenant.scope();
    if (org === tenant.SYSTEM) return;
    this.where(match(org));
  });

  // An unfiltered count would leak the size of other organisations' data
  schema.pre("estimatedDocumentCount", function () {
    if (tenant.scope() !== tenant.SYSTEM) {
      throw new tenant.TenantContextError("estimatedDocumentCount is not organisation-scoped; use countDocuments");
    }
  });

  // ── Aggregation ───────────────────────────────────────────────────────────
  schema.pre("aggregate", function () {
    const org = tenant.scope();
    if (org === tenant.SYSTEM) return;
    this.pipeline().unshift({ $match: match(org) });
  });

  // ── Document writes ───────────────────────────────────────────────────────
  // On "validate" too: Mongoose validates before the save hooks run, and the
  // required orgId must already be set by then. "save" covers validateBeforeSave: false.
  function stampOrg() {
    const org = tenant.scope();
    if (org === tenant.SYSTEM) return; // system writes set orgId explicitly (required validator)
    if (this.isNew && !this.orgId) {
      this.orgId = org;
      return;
    }

    // Loaded with a projection that left orgId out (e.g. .select("publicKey keyVersion")):
    // there's nothing to compare, so let the database check it instead. $where is
    // added to the save's update filter, so the write only lands if the document
    // really belongs to this organisation (otherwise DocumentNotFoundError).
    if (!this.isNew && !this.isSelected("orgId")) {
      this.$where = { ...(this.$where || {}), ...match(org) };
      return;
    }
    if (!same(this.orgId, org)) throw mismatch();
  }
  schema.pre("validate", stampOrg);
  schema.pre("save", stampOrg);

  schema.pre("insertMany", function (next, docs) {
    try {
      const org = tenant.scope();
      if (org !== tenant.SYSTEM) {
        for (const d of Array.isArray(docs) ? docs : [docs]) {
          if (!d.orgId) d.orgId = org;
          else if (!same(d.orgId, org)) throw mismatch();
        }
      }
      next();
    } catch (err) {
      next(err);
    }
  });

  schema.pre("bulkWrite", function (next, ops) {
    try {
      const org = tenant.scope();
      if (org !== tenant.SYSTEM) {
        for (const op of ops) {
          const [kind] = Object.keys(op);
          const body = op[kind];
          if (kind === "insertOne") {
            if (!body.document.orgId) body.document.orgId = org;
            else if (!same(body.document.orgId, org)) throw mismatch();
          } else {
            // A top-level equality (not $and), so an upsert also stamps orgId on
            // the document it inserts. Overwrites any orgId the caller passed.
            body.filter = { ...(body.filter || {}), ...match(org) };
          }
        }
      }
      next();
    } catch (err) {
      next(err);
    }
  });
}

module.exports = tenantPlugin;
module.exports.QUERY_OPS = QUERY_OPS;
