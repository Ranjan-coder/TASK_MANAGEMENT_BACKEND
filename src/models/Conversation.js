const mongoose = require("mongoose");
const tenantPlugin = require("./plugins/tenant.plugin");

const { STAGE_KEYS: PROJECT_STAGES } = require("../config/projectStages");

// Stage keys come from each company's workflow (modules/workflows/engine/tree.js KEY_RE)
const STAGE_KEY_RE = /^[a-z][a-z0-9_]{1,39}$/;
const HISTORY_KINDS = ["next", "back", "jump", "note", "activate", "deactivate", "tick", "untick", "extra", "extra_done", "checklist", "migrate"];

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
        // Status timeline shown to the customer (R1). `stage` is the current top-level
        // stage key of the company's workflow (project-workflow-plan.md); kept for
        // filters and the pipeline. Older projects without `flow` use the Basic stages.
        stage: { type: String, match: STAGE_KEY_RE, default: "consultation" },
        // Where the project is in its workflow version (modules/workflows)
        flow: {
          type: {
            versionId: { type: mongoose.Schema.Types.ObjectId, ref: "WorkflowVersion", required: true },
            version: { type: Number, required: true },
            stepKey: { type: String, required: true, maxlength: 81 },
            // Any-order stages: ticked sub-stages, one bit each ({ stageKey: bitmask }).
            // Mixed (not Map) so the atomic $bit update isn't re-cast by Mongoose;
            // keys are validated stage keys (engine/tree.js KEY_RE).
            ticks: { type: mongoose.Schema.Types.Mixed, default: {} },
            // Optional sub-stages switched on for this project (W5): "stage/sub"
            activated: {
              type: [{ key: { type: String, maxlength: 81 }, at: Date, by: { type: mongoose.Schema.Types.ObjectId, ref: "User" }, note: { type: String, maxlength: 300 }, _id: false }],
              default: []
            },
            // "Additional work" items (C2), each blocks leaving its stage until done
            extras: {
              type: [
                {
                  stageKey: { type: String, maxlength: 40 },
                  note: { type: String, maxlength: 300 },
                  done: { type: Boolean, default: false },
                  at: Date,
                  by: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
                  doneAt: { type: Date, default: null },
                  doneBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null }
                }
              ],
              default: []
            },
            // Gate checklists done (E3): "stage:item"
            checks: { type: [{ type: String, maxlength: 81 }], default: [] },
            enteredAt: { type: Date, default: Date.now }, // entered the current step
            stageEnteredAt: { type: Date, default: Date.now }, // entered the current stage
            dueAt: { type: Date, default: null }, // E1: when the current stage should be done
            overdueNotifiedAt: { type: Date, default: null } // E1: one alert per overdue stage
          },
          default: undefined,
          _id: false
        },
        stageHistory: {
          type: [
            {
              stage: { type: String, maxlength: 40 },
              step: { type: String, maxlength: 81, default: null },
              version: { type: Number, default: null },
              // Where it came from and how
              from: { type: String, maxlength: 81, default: null },
              kind: { type: String, enum: [...HISTORY_KINDS, null], default: null },
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
// Customer Home, payments, monitoring and privacy all look projects up by customer
conversationSchema.index({ "project.customers": 1, lastActivityAt: -1 }, { sparse: true });
// E1: overdue stages, found with one indexed range query (only projects with a due date are indexed)
conversationSchema.index(
  { orgId: 1, "project.flow.dueAt": 1 },
  { partialFilterExpression: { "project.flow.dueAt": { $type: "date" } } }
);
// Pipeline and stage filters
conversationSchema.index({ orgId: 1, "project.stage": 1 }, { partialFilterExpression: { "project.stage": { $type: "string" } } });

conversationSchema.plugin(tenantPlugin); // one organisation per document (module-access-plan.md)
const Conversation = mongoose.model("Conversation", conversationSchema);
module.exports = Conversation;
module.exports.PROJECT_STAGES = PROJECT_STAGES;
