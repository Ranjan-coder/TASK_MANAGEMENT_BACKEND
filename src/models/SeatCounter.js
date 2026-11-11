const mongoose = require("mongoose");
const tenantPlugin = require("./plugins/tenant.plugin");

/**
 * How many people in an organisation hold a module (module-access-plan.md, Phase 4).
 * Seats are claimed with one conditional $inc ("only if used ≤ limit − n"), so two
 * admins can never both take the last seat. services/moduleAccess.service.js keeps
 * it in step with every change to who holds what; recountSeats() rebuilds it.
 */
const seatCounterSchema = new mongoose.Schema(
  {
    module: { type: String, required: true },
    used: { type: Number, default: 0, min: 0 }
  },
  { versionKey: false, timestamps: { createdAt: false, updatedAt: true } }
);

seatCounterSchema.index({ orgId: 1, module: 1 }, { unique: true });

seatCounterSchema.plugin(tenantPlugin); // one organisation per document (module-access-plan.md)
module.exports = mongoose.model("SeatCounter", seatCounterSchema);
