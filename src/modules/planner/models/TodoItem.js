const mongoose = require("mongoose");
const tenantPlugin = require("../../../models/plugins/tenant.plugin");
const { encryptedSchema } = require("./encrypted");

/**
 * One todo. The text is encrypted; done / dueAt stay readable so the app can count
 * and show "overdue" without decrypting, and `rank` orders items in their list.
 */
const todoItemSchema = new mongoose.Schema(
  {
    owner: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    list: { type: mongoose.Schema.Types.ObjectId, ref: "TodoList", required: true },
    enc: { type: encryptedSchema(4096), required: true },
    done: { type: Boolean, default: false },
    doneAt: { type: Date, default: null },
    dueAt: { type: Date, default: null },
    rank: { type: String, required: true, match: /^[0-9A-Za-z]{1,64}$/ },
    version: { type: Number, default: 1 }
  },
  { timestamps: true }
);

todoItemSchema.index({ owner: 1, list: 1, rank: 1 });
todoItemSchema.index({ owner: 1, done: 1, dueAt: 1 }); // "due / overdue" across lists
todoItemSchema.plugin(tenantPlugin);

module.exports = mongoose.model("TodoItem", todoItemSchema);
