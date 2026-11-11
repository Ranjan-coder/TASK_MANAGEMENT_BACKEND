const mongoose = require("mongoose");
const tenantPlugin = require("../../../models/plugins/tenant.plugin");
const { encryptedSchema } = require("./encrypted");

/**
 * A private note. Title, body and tags are one encrypted blob (≤ 64 KB of text);
 * only layout flags stay readable so lists can be sorted and filtered server-side.
 * `version` gives optimistic concurrency between the person's devices.
 */
const COLORS = ["none", "yellow", "green", "blue", "pink", "purple", "grey"];

const noteSchema = new mongoose.Schema(
  {
    owner: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    enc: { type: encryptedSchema(64 * 1024), required: true },
    pinned: { type: Boolean, default: false },
    color: { type: String, enum: COLORS, default: "none" },
    archived: { type: Boolean, default: false },
    version: { type: Number, default: 1 }
  },
  { timestamps: true }
);

// Owner's list, newest first (cursor pagination on updatedAt + _id)
noteSchema.index({ owner: 1, archived: 1, updatedAt: -1, _id: -1 });
noteSchema.plugin(tenantPlugin);

module.exports = mongoose.model("Note", noteSchema);
module.exports.COLORS = COLORS;
