const mongoose = require("mongoose");

const attachmentSchema = new mongoose.Schema(
  {
    fileName: {
      type: String,
      required: true
    },
    originalName: {
      type: String,
      required: true
    },
    fileType: {
      type: String,
      enum: ["pdf", "doc", "docx", "xls", "xlsx", "image", "link", "other"],
      required: true
    },
    mimeType: {
      type: String,
      default: "application/octet-stream"
    },
    fileSize: {
      type: Number,
      default: 0
    },
    url: {
      type: String,
      required: true
    },
    publicId: {
      type: String,
      default: ""
    },
    uploadedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true
    },
    relatedTo: {
      entityType: {
        type: String,
        enum: ["task", "comment", "message"],
        required: true
      },
      entityId: {
        type: mongoose.Schema.Types.ObjectId,
        required: true
      }
    }
  },
  {
    timestamps: true
  }
);

attachmentSchema.index({ "relatedTo.entityType": 1, "relatedTo.entityId": 1 });
attachmentSchema.index({ uploadedBy: 1 });

const Attachment = mongoose.model("Attachment", attachmentSchema);
module.exports = Attachment;
