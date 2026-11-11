const mongoose = require("mongoose");

/**
 * Who a customer should contact about what (project-contacts-plan.md). Used
 * for a project's own contacts (Conversation.project.contacts) and the
 * company's defaults (Setting.projectContacts); both lists are small (≤ 8).
 */
const CONTACT_TOPICS = ["design", "site", "payments", "general", "custom"];
const MAX_CONTACTS = 8;

const projectContactSchema = new mongoose.Schema(
  {
    topic: { type: String, enum: CONTACT_TOPICS, required: true },
    // Required for "custom" (e.g. "Furniture delivery"); optional wording for the others
    label: { type: String, trim: true, maxlength: 40, default: "" },
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    // Chosen by the admin (prefilled from the profile, P3): nothing is shown automatically
    phone: { type: String, trim: true, maxlength: 20, default: "" },
    whatsapp: { type: Boolean, default: false },
    email: { type: String, trim: true, lowercase: true, maxlength: 120, default: "" },
    hours: { type: String, trim: true, maxlength: 60, default: "" }
  },
  { _id: false }
);

module.exports = { projectContactSchema, CONTACT_TOPICS, MAX_CONTACTS };
