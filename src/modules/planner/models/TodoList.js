const mongoose = require("mongoose");
const tenantPlugin = require("../../../models/plugins/tenant.plugin");
const { encryptedSchema } = require("./encrypted");

/** A todo list. The title is encrypted; `rank` orders lists (fractional index, rank.js). */
const todoListSchema = new mongoose.Schema(
  {
    owner: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    enc: { type: encryptedSchema(1024), required: true },
    rank: { type: String, required: true, match: /^[0-9A-Za-z]{1,64}$/ },
    version: { type: Number, default: 1 }
  },
  { timestamps: true }
);

todoListSchema.index({ owner: 1, rank: 1 });
todoListSchema.plugin(tenantPlugin);

module.exports = mongoose.model("TodoList", todoListSchema);
