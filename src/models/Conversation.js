const mongoose = require("mongoose");

const PROJECT_STAGES = ["consultation", "site_measurement", "design", "quotation", "production", "installation", "handover"];

const memberSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true
    },
    role: {
      type: String,
      enum: ["admin", "member"],
      default: "member"
    },
    joinedAt: {
      type: Date,
      default: Date.now
    },
    lastRead: {
      type: Date,
      default: null
    }
  },
  { _id: false }
);

const conversationSchema = new mongoose.Schema(
  {
    type: {
      type: String,
      enum: ["dm", "group"],
      required: true
    },
    name: {
      type: String,
      trim: true,
      maxlength: 100,
      default: null // null for DMs
    },
    avatarUrl: {
      type: String,
      default: null
    },
    members: {
      type: [memberSchema],
      validate: {
        validator: function (members) {
          if (this.type === "dm") return members.length === 2;
          return members.length >= 2;
        },
        message: "DMs must have exactly 2 members; groups at least 2"
      }
    },
    // E2E: per-member encrypted group key (groups only)
    // Key: userId string, Value: base64(AES-GCM-encrypted groupKey)
    groupKeys: {
      type: Map,
      of: String,
      default: {}
    },
    // Set for Bonito project chats (a group managed from Admin → Projects).
    // Membership, name and roles can only be changed there, never from the chat.
    project: {
      type: {
        status: { type: String, enum: ["active", "on_hold", "completed"], default: "active" },
        customers: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
        leadDesigner: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
        backupDesigner: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
        manager: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
        createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
        createdAt: { type: Date, default: Date.now },
        // Status timeline shown to the customer (R1)
        stage: { type: String, enum: PROJECT_STAGES, default: "consultation" },
        stageHistory: {
          type: [
            {
              stage: { type: String, enum: PROJECT_STAGES },
              at: { type: Date, default: Date.now },
              by: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
              note: { type: String, maxlength: 300, default: "" },
              _id: false
            }
          ],
          default: []
        },
        expectedHandover: { type: Date, default: null }
      },
      default: undefined,
      _id: false
    },
    // True when the current group key was made by someone outside the chat (the
    // admin who created the project) or a member was removed: the next staff
    // member of the group who opens it replaces the key.
    rekeyRequested: { type: Boolean, default: false },
    // Abuse alerts (project chats): flags are counted from countFrom; while an
    // incident is open no second alert is raised (cooldown)
    moderation: {
      openIncident: { type: mongoose.Schema.Types.ObjectId, ref: "ModerationIncident", default: null },
      warningAt: { type: Date, default: null },
      countFrom: { type: Date, default: null }
    },
    // Versioned group keys. Each version is the group AES key wrapped for each
    // member with ECDH(wrapper private key, member public key). Old versions are
    // kept so history stays readable; removing a member adds a new version.
    // The legacy `groupKeys` map above is treated as version 0.
    groupKeyring: {
      type: [
        {
          version: { type: Number, required: true, min: 1 },
          createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
          createdAt: { type: Date, default: Date.now },
          keys: {
            type: Map,
            of: new mongoose.Schema(
              {
                wrapped: { type: String, required: true, maxlength: 512 },
                wrappedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
                wrapperKeyVersion: { type: Number, required: true, min: 0 },
                recipientKeyVersion: { type: Number, required: true, min: 0 }
              },
              { _id: false }
            ),
            default: {}
          },
          _id: false
        }
      ],
      default: []
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true
    },
    // Denormalized for sidebar performance — avoids expensive $lookup
    lastMessage: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Message",
      default: null
    },
    lastActivityAt: {
      type: Date,
      default: Date.now
    },
    isArchived: {
      type: Boolean,
      default: false
    }
  },
  { timestamps: true }
);

// Indexes for performance
conversationSchema.index({ "members.user": 1 });
conversationSchema.index({ type: 1, "members.user": 1 });
conversationSchema.index({ lastActivityAt: -1 });
conversationSchema.index({ "project.status": 1, lastActivityAt: -1 }, { sparse: true });
conversationSchema.index({ isArchived: 1, "members.user": 1 });

const Conversation = mongoose.model("Conversation", conversationSchema);
module.exports = Conversation;
module.exports.PROJECT_STAGES = PROJECT_STAGES;
