const mongoose = require("mongoose");
const tenantPlugin = require("./plugins/tenant.plugin");

/** One entry in the abuse word list. `term` is stored normalised (see utils/moderationText). */
const moderationTermSchema = new mongoose.Schema(
  {
    term: { type: String, required: true, maxlength: 80 },
    display: { type: String, required: true, maxlength: 80 },
    severity: { type: String, enum: ["mild", "abusive", "threat"], required: true },
    language: { type: String, enum: ["en", "hi", "hinglish", "other"], default: "other" },
    active: { type: Boolean, default: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null }
  },
  { timestamps: true }
);

moderationTermSchema.index({ orgId: 1, term: 1 }, { unique: true }); // each organisation keeps its own word list
moderationTermSchema.plugin(tenantPlugin); // one organisation per document (module-access-plan.md)
module.exports = mongoose.model("ModerationTerm", moderationTermSchema);
