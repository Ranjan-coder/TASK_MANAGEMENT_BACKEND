const Conversation = require("../../models/Conversation");
const logger = require("../../utils/logger");
const { mapLimit } = require("../../utils/mapLimit");
const workflows = require("./workflow.service");

/**
 * E1: projects that stayed too long in a stage. Runs every minute per organisation
 * (from the manifest's jobs).
 *
 * One indexed range query on { orgId, project.flow.dueAt } finds them; each is
 * claimed by setting `overdueNotifiedAt` in the same conditional write, so two
 * servers never alert twice and each overdue stage alerts once (moving the
 * project to another stage resets it).
 */
const BATCH = 200;
const DAY = 24 * 60 * 60 * 1000;

const processDue = async (now = new Date()) => {
  const due = await Conversation.find({
    "project.flow.dueAt": { $lte: now },
    "project.flow.overdueNotifiedAt": null,
    "project.status": "active"
  })
    .select("name members project.leadDesigner project.backupDesigner project.manager project.stage project.flow")
    .limit(BATCH)
    .lean();
  if (!due.length) return 0;

  const { sendNotification } = require("../../services/notification.service");
  let sent = 0;
  await mapLimit(due, 10, async (conv) => {
    const claimed = await Conversation.updateOne(
      { _id: conv._id, "project.flow.overdueNotifiedAt": null, "project.flow.dueAt": conv.project.flow.dueAt },
      { $set: { "project.flow.overdueNotifiedAt": now } }
    );
    if (!claimed.modifiedCount) return;
    try {
      const c = await workflows.compiledForProject(conv.project);
      const stage = c.stages[c.stageIndex.get(conv.project.stage)] || null;
      const lists = await require("../../services/org.service").load();
      const head = stage?.departmentId ? lists.deptById.get(String(stage.departmentId))?.head : null;
      const people = new Set(
        [conv.project.leadDesigner, conv.project.backupDesigner, conv.project.manager, head, ...(stage ? [...stage.handlerSet] : [])].filter(Boolean).map(String)
      );
      const late = Math.max(1, Math.round((now - new Date(conv.project.flow.dueAt)) / DAY));
      await Promise.all(
        [...people].map((recipient) =>
          sendNotification({
            recipient,
            type: "project_update",
            title: `Running late: ${conv.name}`,
            message: `${stage?.name || conv.project.stage} is ${late} day(s) over its expected time.`,
            relatedConversation: conv._id
          }).catch((err) => logger.warn(`[WorkflowOverdue] notification failed: ${err.message}`))
        )
      );
      sent += 1;
    } catch (err) {
      logger.error(`[WorkflowOverdue] ${conv._id}: ${err.message}`);
    }
  });
  return sent;
};

module.exports = { processDue };
