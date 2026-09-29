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
    delivery: { type: String, enum: ["public", "private"], default: "public" },
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

// Private files: every API response carries a fresh 10-minute signed link instead of a permanent URL
attachmentSchema.set("toJSON", {
  transform: (doc, ret) => {
    if (ret.delivery === "private" && ret.publicId) {
      const cloudinary = require("../config/cloudinary");
      const isImage = ret.fileType === "image";
      const ext = String(ret.fileName || "").split(".").pop();
      ret.url = cloudinary.utils.private_download_url(isImage ? ret.publicId : ret.publicId, isImage ? ext : "", {
        type: "private",
        resource_type: isImage ? "image" : "raw",
        expires_at: Math.floor(Date.now() / 1000) + 600
      });
    }
    return ret;
  }
});

attachmentSchema.index({ "relatedTo.entityType": 1, "relatedTo.entityId": 1 });
attachmentSchema.index({ uploadedBy: 1 });

const Attachment = mongoose.model("Attachment", attachmentSchema);
module.exports = Attachment;
