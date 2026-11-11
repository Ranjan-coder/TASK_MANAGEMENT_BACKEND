const ProjectFinance = require("../../models/ProjectFinance");
const logger = require("../../utils/logger");

/**
 * What happens when a project enters a stage, beyond moving it.
 *
 * E4: payment milestones linked to the stage fall due. Each milestone still
 * "upcoming" and linked to this stage gets a due date `paymentDueDays` from now
 * (default 3), unless it already has an earlier one. One update with an array
 * filter (no read-modify-write); the existing payment reminders then nudge the
 * customer, and the payment gate (E3) waits for it.
 */
const DEFAULT_PAYMENT_DAYS = 3;
const DAY = 24 * 60 * 60 * 1000;

const stageEntered = async ({ conv, stage, at }) => {
  try {
    const due = new Date(at.getTime() + (stage.paymentDueDays ?? DEFAULT_PAYMENT_DAYS) * DAY);
    const res = await ProjectFinance.updateOne(
      { conversation: conv._id, "milestones.stageKey": stage.key },
      { $set: { "milestones.$[m].dueDate": due }, $inc: { __v: 1 } },
      // "no due date yet, or a later one": $not $lte also matches a missing/null date
      // (array filters can't mix $or with other fields)
      { arrayFilters: [{ "m.stageKey": stage.key, "m.status": "upcoming", "m.dueDate": { $not: { $lte: due } } }] }
    );
    if (res.modifiedCount) {
      const { notify } = require("../../services/projectExtras.service")._helpers;
      await notify(conv.project.customers, {
        title: "A payment is now due",
        message: `"${conv.name}" reached ${stage.customerName}. See Payments for the amount and how to pay.`,
        relatedConversation: conv._id
      });
    }
  } catch (err) {
    // Never fail the stage move because of a payment side effect
    logger.warn(`[Workflows] Stage payment trigger skipped: ${err.message}`);
  }
};

module.exports = { stageEntered };
