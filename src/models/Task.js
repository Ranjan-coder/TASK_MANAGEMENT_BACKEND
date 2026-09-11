const mongoose = require("mongoose");

const activityItemSchema = new mongoose.Schema({
  action: {
    type: String,
    enum: ["created", "status_changed", "priority_changed", "reassigned", "commented", "attachment_added", "edited"],
    required: true
  },
  performedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true
  },
  meta: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  },
  timestamp: {
    type: Date,
    default: Date.now
  }
});

const taskSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      required: [true, "Task title is required"],
      trim: true,
      maxlength: 200
    },
    description: {
      type: String,
      default: ""
    },
    status: {
      type: String,
      enum: ["todo", "in_progress", "in_review", "completed", "blocked", "cancelled"],
      default: "todo"
    },
    priority: {
      type: String,
      enum: ["low", "medium", "high", "critical"],
      default: "medium"
    },
    assignedTo: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User"
      }
    ],
    assignedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true
    },
    dueDate: {
      type: Date
    },
    startDate: {
      type: Date
    },
    completedAt: {
      type: Date
    },
    tags: [
      {
        type: String,
        trim: true
      }
    ],
    category: {
      type: String,
      default: "General",
      trim: true
    },
    attachments: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Attachment"
      }
    ],
    watchers: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User"
      }
    ],
    parentTask: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Task",
      default: null
    },
    activityLog: [activityItemSchema],
    isArchived: {
      type: Boolean,
      default: false
    }
  },
  {
    timestamps: true
  }
);

taskSchema.index({ assignedTo: 1, status: 1 });
taskSchema.index({ assignedBy: 1 });
taskSchema.index({ dueDate: 1 });
taskSchema.index({ isArchived: 1 });
taskSchema.index({ title: "text", description: "text" });

const Task = mongoose.model("Task", taskSchema);
module.exports = Task;
