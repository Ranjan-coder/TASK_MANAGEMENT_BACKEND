const mongoose = require("mongoose");

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
conversationSchema.index({ isArchived: 1, "members.user": 1 });

const Conversation = mongoose.model("Conversation", conversationSchema);
module.exports = Conversation;
