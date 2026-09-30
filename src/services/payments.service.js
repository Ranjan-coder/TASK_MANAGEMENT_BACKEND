const Conversation = require("../models/Conversation");
const ProjectFinance = require("../models/ProjectFinance");
const User = require("../models/User");
const ApiError = require("../utils/ApiError");
const logger = require("../utils/logger");
const { nextSequence } = require("../models/Counter");
const media = require("./media.service");
const { getSlaSettings, getEscalationRecipients } = require("./settings.service");

/**
 * Payment milestones (R9). No gateway: customers pay Bonito by UPI / bank
 * transfer and report the reference; an admin confirms it against the bank
 * statement, which issues a numbered receipt. The official GST invoice is
 * uploaded by accounts as a PDF.
 */

const DAY = 24 * 3600 * 1000;
const REMIND_BEFORE_DAYS = 3;
const OVERDUE_REPEAT_DAYS = 3;
const METHOD_LABELS = { upi: "UPI", bank_transfer: "Bank transfer", cheque: "Cheque", cash: "Cash", card: "Card" };
const idStr = (v) => (v ? String(v._id || v) : null);
const rupees = (paise) => `₹${(paise / 100).toLocaleString("en-IN", { minimumFractionDigits: paise % 100 ? 2 : 0, maximumFractionDigits: 2 })}`;

const notify = async (recipients, payload) => {
  const { sendNotification } = require("./notification.service");
  await Promise.all(
    [...new Set(recipients.filter(Boolean).map(String))].map((recipient) =>
      sendNotification({ recipient, type: "project_update", ...payload }).catch((err) => logger.warn(`Payment notification failed: ${err.message}`))
    )
  );
};

const loadProject = async (conversationId) => {
  const conv = await Conversation.findById(conversationId).select("name members project");
  if (!conv?.project) throw new ApiError(404, "Project not found");
  return conv;
};

const isProjectCustomer = (conv, userId) =>
  conv.project.customers.some((c) => idStr(c) === String(userId)) && conv.members.some((m) => idStr(m.user) === String(userId));

const summarise = (f) => {
  const active = f.milestones.filter((m) => m.status !== "waived");
  const paid = active.filter((m) => m.status === "paid").reduce((a, m) => a + (m.paid?.amountPaise || 0), 0);
  const scheduled = active.reduce((a, m) => a + m.amountPaise, 0);
  const now = Date.now();
  const next = active.filter((m) => m.status !== "paid").sort((a, b) => (a.dueDate ? +a.dueDate : Infinity) - (b.dueDate ? +b.dueDate : Infinity))[0];
  return {
    contractValuePaise: f.contractValuePaise,
    scheduledPaise: scheduled,
    paidPaise: paid,
    balancePaise: Math.max(0, f.contractValuePaise - paid),
    overdue: active.filter((m) => m.status === "upcoming" && m.dueDate && +m.dueDate < now).length,
    verifying: active.filter((m) => m.status === "verifying").length,
    next: next ? { _id: next._id, title: next.title, amountPaise: next.amountPaise, dueDate: next.dueDate, status: next.status } : null
  };
};

/** Customer / public view of a schedule (no internal ids of staff). */
const customerView = (f, conv) => ({
  projectId: conv._id,
  projectName: conv.name,
  notes: f.notes,
  gstRatePct: f.gstRatePct,
  summary: summarise(f),
  milestones: f.milestones.map((m) => ({
    _id: m._id,
    title: m.title,
    amountPaise: m.amountPaise,
    dueDate: m.dueDate,
    status: m.status,
    overdue: m.status === "upcoming" && m.dueDate && +m.dueDate < Date.now(),
    claim: m.claim ? { method: m.claim.method, reference: m.claim.reference, amountPaise: m.claim.amountPaise, paidOn: m.claim.paidOn } : null,
    lastClaimRejection: m.lastClaimRejection?.note ? { note: m.lastClaimRejection.note, at: m.lastClaimRejection.at } : null,
    paid: m.paid?.receiptNo
      ? { amountPaise: m.paid.amountPaise, method: m.paid.method, reference: m.paid.reference, paidOn: m.paid.paidOn, receiptNo: m.paid.receiptNo }
      : null,
    hasInvoice: Boolean(m.invoice?.publicId)
  }))
});

const paymentDetails = async () => {
  const { settings } = await getSlaSettings();
  const p = settings.payments || {};
  return {
    companyName: p.companyName || "Bonito Interiors",
    upiId: p.upiId || "",
    bankName: p.bankName || "",
    accountName: p.accountName || "",
    accountNumber: p.accountNumber || "",
    ifsc: p.ifsc || "",
    instructions: p.instructions || "",
    // Shown for 14 days after the account/UPI changed, so customers can double-check
    changedRecently: Boolean(p.payeeChangedAt && Date.now() - new Date(p.payeeChangedAt).getTime() < 14 * DAY),
    changedAt: p.payeeChangedAt || null
  };
};

// ── Customer ─────────────────────────────────────────────────────────────────

const listMine = async (customerId) => {
  const convs = await Conversation.find({ "project.customers": customerId, "members.user": customerId }).select("name members project");
  const finances = await ProjectFinance.find({ conversation: { $in: convs.map((c) => c._id) } });
  const byConv = new Map(finances.map((f) => [String(f.conversation), f]));
  return {
    payTo: await paymentDetails(),
    projects: convs.filter((c) => byConv.has(String(c._id))).map((c) => customerView(byConv.get(String(c._id)), c))
  };
};

const findMilestone = async (conversationId, milestoneId) => {
  const f = await ProjectFinance.findOne({ conversation: conversationId });
  const m = f?.milestones.id(milestoneId);
  if (!m) throw new ApiError(404, "Payment not found");
  return { f, m };
};

/** "I've paid": the customer reports a payment for an admin to confirm. */
const claimPayment = async ({ conversationId, milestoneId, customer, method, reference, amountPaise, paidOn, note }) => {
  const conv = await loadProject(conversationId);
  if (!isProjectCustomer(conv, customer._id)) throw new ApiError(404, "Payment not found");
  if (["upi", "bank_transfer", "cheque"].includes(method) && !reference) throw new ApiError(400, "Add the transaction reference (UTR / cheque number)");
  if (+paidOn > Date.now() + DAY) throw new ApiError(400, "The payment date can't be in the future");
  const { m } = await findMilestone(conversationId, milestoneId);
  if (m.status !== "upcoming") throw new ApiError(409, m.status === "paid" ? "This payment is already confirmed" : "We're already checking a payment for this");

  const updated = await ProjectFinance.findOneAndUpdate(
    { conversation: conversationId, milestones: { $elemMatch: { _id: milestoneId, status: "upcoming" } } },
    { $inc: { __v: 1 }, $set: { "milestones.$.status": "verifying", "milestones.$.claim": { method, reference, amountPaise, paidOn, note, at: new Date(), by: customer._id } } },
    { new: true }
  );
  if (!updated) throw new ApiError(409, "This payment was just updated. Please reload.");
  const admins = await getEscalationRecipients();
  await notify(admins.map((a) => a._id), {
    title: "Payment to confirm",
    message: `${customer.name} says they paid ${rupees(amountPaise)} (${METHOD_LABELS[method]}${reference ? ` ${reference}` : ""}) for "${m.title}" — ${conv.name}.`
  });
  return customerView(updated, conv);
};

/** Receipt data (for the customer on the project, or an admin). */
const getReceipt = async ({ conversationId, milestoneId, viewer }) => {
  const conv = await loadProject(conversationId);
  const isAdmin = ["admin", "superadmin"].includes(viewer.role);
  if (!isAdmin && !isProjectCustomer(conv, viewer._id)) throw new ApiError(404, "Receipt not found");
  const { f, m } = await findMilestone(conversationId, milestoneId);
  if (m.status !== "paid" || !m.paid?.receiptNo) throw new ApiError(404, "No receipt yet — the payment isn't confirmed");
  const { settings } = await getSlaSettings();
  const p = settings.payments || {};
  const customers = await User.find({ _id: { $in: conv.project.customers } }).select("name");
  const gross = m.paid.amountPaise;
  const taxable = f.gstRatePct ? Math.round(gross / (1 + f.gstRatePct / 100)) : gross;
  return {
    receiptNo: m.paid.receiptNo,
    issuedAt: m.paid.confirmedAt,
    company: { name: p.companyName || "Bonito Interiors", address: p.companyAddress || "", gstin: p.gstin || "" },
    customerNames: customers.map((c) => c.name),
    projectName: conv.name,
    milestone: m.title,
    amountPaise: gross,
    gstRatePct: f.gstRatePct,
    taxablePaise: taxable,
    gstPaise: gross - taxable,
    method: METHOD_LABELS[m.paid.method] || m.paid.method,
    reference: m.paid.reference || "",
    paidOn: m.paid.paidOn,
    hasInvoice: Boolean(m.invoice?.publicId)
  };
};

const invoiceLink = async ({ conversationId, milestoneId, viewer }) => {
  const conv = await loadProject(conversationId);
  const isAdmin = ["admin", "superadmin"].includes(viewer.role);
  if (!isAdmin && !isProjectCustomer(conv, viewer._id)) throw new ApiError(404, "Invoice not found");
  const { m } = await findMilestone(conversationId, milestoneId);
  if (!m.invoice?.publicId) throw new ApiError(404, "No invoice uploaded yet");
  return { url: media.invoiceUrl(m.invoice.publicId), fileName: m.invoice.fileName };
};

// ── Admin ────────────────────────────────────────────────────────────────────

const adminList = async ({ filter }) => {
  const finances = await ProjectFinance.find().select("conversation contractValuePaise milestones updatedAt").lean();
  const convIds = finances.map((f) => f.conversation);
  // Independent lookups: run them together
  const [convs, withoutSchedule] = await Promise.all([
    Conversation.find({ _id: { $in: convIds } })
      .select("name project.status project.customers project.leadDesigner")
      .populate("project.customers", "name phone")
      .populate("project.leadDesigner", "name")
      .lean(),
    Conversation.find({ project: { $exists: true }, "project.status": { $ne: "completed" }, _id: { $nin: convIds } })
      .select("name project.customers")
      .populate("project.customers", "name")
      .limit(100)
      .lean()
  ]);
  const byConv = new Map(convs.map((c) => [String(c._id), c]));
  let rows = finances
    .filter((f) => byConv.has(String(f.conversation)))
    .map((f) => {
      const c = byConv.get(String(f.conversation));
      return {
        projectId: c._id,
        projectName: c.name,
        status: c.project.status,
        customers: c.project.customers.map((u) => ({ name: u.name, phone: u.phone })),
        leadDesigner: c.project.leadDesigner?.name || null,
        summary: summarise(f),
        updatedAt: f.updatedAt
      };
    });
  if (filter === "verifying") rows = rows.filter((r) => r.summary.verifying > 0);
  if (filter === "overdue") rows = rows.filter((r) => r.summary.overdue > 0);
  rows.sort((a, b) => b.summary.verifying - a.summary.verifying || b.summary.overdue - a.summary.overdue || a.projectName.localeCompare(b.projectName));
  return { rows, withoutSchedule: withoutSchedule.map((c) => ({ projectId: c._id, projectName: c.name, customers: c.project.customers.map((u) => u.name) })) };
};

const adminGet = async (conversationId) => {
  const conv = await loadProject(conversationId);
  const f = await ProjectFinance.findOne({ conversation: conversationId }).populate("milestones.paid.confirmedBy", "name").lean();
  return { projectId: conv._id, projectName: conv.name, finance: f ? { ...f, summary: summarise(f) } : null };
};

/**
 * Saves the schedule. Paid or waived milestones are locked: they must stay,
 * with the same amount. Each milestone line keeps its id when edited.
 */
const saveSchedule = async ({ conversationId, admin, contractValuePaise, gstRatePct, notes, milestones }) => {
  const conv = await loadProject(conversationId);
  let f = await ProjectFinance.findOne({ conversation: conversationId });
  const existing = new Map((f?.milestones || []).map((m) => [String(m._id), m]));

  for (const [id, m] of existing) {
    if (["paid", "waived", "verifying"].includes(m.status)) {
      const incoming = milestones.find((x) => x._id === id);
      if (!incoming) throw new ApiError(400, `"${m.title}" has a payment and can't be removed`);
      if (incoming.amountPaise !== m.amountPaise) throw new ApiError(400, `"${m.title}" has a payment, so its amount can't change`);
    }
  }
  for (const x of milestones) if (x._id && !existing.has(x._id)) throw new ApiError(400, "Unknown payment line");

  const total = milestones.reduce((a, m) => a + m.amountPaise, 0);
  if (total > contractValuePaise) throw new ApiError(400, `The milestones add up to ${rupees(total)}, more than the contract value ${rupees(contractValuePaise)}`);

  const next = milestones.map((x) => {
    const old = x._id ? existing.get(x._id) : null;
    if (old) {
      old.title = x.title;
      old.amountPaise = x.amountPaise;
      if (+new Date(old.dueDate || 0) !== +new Date(x.dueDate || 0)) {
        old.dueDate = x.dueDate || null;
        old.reminderSentAt = null; // new date → remind again
        old.overdueReminderAt = null;
      }
      return old;
    }
    return { title: x.title, amountPaise: x.amountPaise, dueDate: x.dueDate || null };
  });

  const removed = [...existing.values()].filter((m) => !milestones.some((x) => x._id === String(m._id)));
  if (!f) f = new ProjectFinance({ conversation: conv._id, contractValuePaise, gstRatePct });
  Object.assign(f, { contractValuePaise, gstRatePct, notes, updatedBy: admin._id });
  f.milestones = next;
  try {
    await f.save();
  } catch (err) {
    if (err.name === "VersionError") throw new ApiError(409, "A payment on this project changed while you were editing. Reload and try again.");
    throw err;
  }
  for (const m of removed) if (m.invoice?.publicId) media.destroyInvoice(m.invoice.publicId);
  return adminGet(conversationId);
};

/** Admin confirms a payment (from a customer's claim or recorded directly). Issues the receipt. */
/**
 * `claimedOnly`: people confirming through the "payments.confirm" add-on (not admins)
 * may only confirm a payment the customer has told us about, not record one directly.
 */
const confirmPayment = async ({ conversationId, milestoneId, admin, method, reference, amountPaise, paidOn, claimedOnly = false }) => {
  const conv = await loadProject(conversationId);
  const { m } = await findMilestone(conversationId, milestoneId);
  const open = claimedOnly ? ["verifying"] : ["upcoming", "verifying"];
  if (claimedOnly && m.status === "upcoming") throw new ApiError(403, "Only an admin can record a payment the customer hasn't reported", [{ code: "CLAIM_REQUIRED" }]);
  if (!open.includes(m.status)) throw new ApiError(409, "This payment is already closed");
  // Claim the milestone first, so a lost race never uses up a receipt number (no gaps in the series)
  const updated = await ProjectFinance.findOneAndUpdate(
    { conversation: conversationId, milestones: { $elemMatch: { _id: milestoneId, status: { $in: open } } } },
    {
      $inc: { __v: 1 },
      $set: {
        "milestones.$.status": "paid",
        "milestones.$.paid": { amountPaise, method, reference, paidOn, confirmedBy: admin._id, confirmedAt: new Date() }
      }
    },
    { new: true }
  );
  if (!updated) throw new ApiError(409, "This payment was just updated. Please reload.");
  const receiptNo = `BON-R-${new Date().getFullYear()}-${await nextSequence("receipt", 1000)}`;
  await ProjectFinance.updateOne({ _id: updated._id, "milestones._id": milestoneId }, { $inc: { __v: 1 }, $set: { "milestones.$.paid.receiptNo": receiptNo } });
  await notify(conv.project.customers, {
    title: "Payment received — thank you",
    message: `${rupees(amountPaise)} for "${m.title}" (${conv.name}). Receipt ${receiptNo} is in Payments.`
  });
  // A friend's first payment qualifies the referral
  await require("./referrals.service").onFirstPayment(conv.project.customers, conv.project.customers).catch((err) => logger.warn(`Referral check failed: ${err.message}`));
  return { receiptNo, ...(await adminGet(conversationId)) };
};

const rejectClaim = async ({ conversationId, milestoneId, note }) => {
  const conv = await loadProject(conversationId);
  const updated = await ProjectFinance.findOneAndUpdate(
    { conversation: conversationId, milestones: { $elemMatch: { _id: milestoneId, status: "verifying" } } },
    { $inc: { __v: 1 }, $set: { "milestones.$.status": "upcoming", "milestones.$.lastClaimRejection": { note, at: new Date() } }, $unset: { "milestones.$.claim": "" } },
    { new: true }
  );
  if (!updated) throw new ApiError(409, "There's no payment waiting to be checked");
  const m = updated.milestones.id(milestoneId);
  await notify(conv.project.customers, { title: "We couldn't find your payment", message: `"${m.title}" — ${note}`.slice(0, 300) });
  return adminGet(conversationId);
};

const waiveMilestone = async ({ conversationId, milestoneId }) => {
  const updated = await ProjectFinance.findOneAndUpdate(
    { conversation: conversationId, milestones: { $elemMatch: { _id: milestoneId, status: { $in: ["upcoming", "verifying"] } } } },
    { $inc: { __v: 1 }, $set: { "milestones.$.status": "waived" }, $unset: { "milestones.$.claim": "" } },
    { new: true }
  );
  if (!updated) throw new ApiError(409, "Only unpaid payments can be waived");
  return adminGet(conversationId);
};

const attachInvoice = async ({ conversationId, milestoneId, file }) => {
  const conv = await loadProject(conversationId);
  const { m } = await findMilestone(conversationId, milestoneId);
  const up = await media.uploadInvoicePdf(file.buffer);
  const fileName = String(file.originalname || "invoice.pdf").replace(/[^\w.\- ]+/g, "_").slice(0, 80);
  const old = m.invoice?.publicId;
  await ProjectFinance.updateOne(
    { conversation: conversationId, "milestones._id": milestoneId },
    { $inc: { __v: 1 }, $set: { "milestones.$.invoice": { publicId: up.publicId, fileName, uploadedAt: new Date() } } }
  );
  if (old) media.destroyInvoice(old);
  await notify(conv.project.customers, { title: "Invoice available", message: `The invoice for "${m.title}" (${conv.name}) is in Payments.` });
  return adminGet(conversationId);
};

// ── Reminders (from the minute job, at most hourly) ──────────────────────────

let lastReminderRun = 0;
const runReminders = async (now = new Date()) => {
  if (+now - lastReminderRun < 60 * 60 * 1000) return 0;
  lastReminderRun = +now;
  const soon = new Date(+now + REMIND_BEFORE_DAYS * DAY);
  let sent = 0;
  // Walk every matching schedule in _id order, 200 at a time. (A single .limit(500)
  // re-read the same 500 every hour once there were more, and the rest were never reminded.)
  let lastId = null;
  for (;;) {
    const finances = await ProjectFinance.find({
      ...(lastId ? { _id: { $gt: lastId } } : {}),
      milestones: { $elemMatch: { status: "upcoming", dueDate: { $ne: null, $lte: soon } } }
    })
      .sort({ _id: 1 })
      .limit(200)
      .select("conversation milestones")
      .lean();
    if (!finances.length) break;
    lastId = finances[finances.length - 1]._id;
    // One query for all their projects instead of one per schedule
    const convs = await Conversation.find({ _id: { $in: finances.map((x) => x.conversation) } }).select("name project").lean();
    const convById = new Map(convs.map((c) => [String(c._id), c]));
    sent += await remindBatch(finances, convById, now);
  }
  return sent;
};

const remindBatch = async (finances, convById, now) => {
  let sent = 0;
  for (const f of finances) {
    const conv = convById.get(String(f.conversation));
    if (!conv?.project || conv.project.status === "completed") continue;
    for (const m of f.milestones) {
      if (m.status !== "upcoming" || !m.dueDate) continue;
      const overdue = +m.dueDate < +now;
      const field = overdue ? "overdueReminderAt" : "reminderSentAt";
      const gap = overdue ? OVERDUE_REPEAT_DAYS * DAY : Infinity;
      if (m[field] && (gap === Infinity || +now - +m[field] < gap)) continue;
      // Claim the reminder so two servers don't both send it
      const claimed = await ProjectFinance.updateOne(
        { _id: f._id, milestones: { $elemMatch: { _id: m._id, [field]: m[field] || null } } },
        { $inc: { __v: 1 }, $set: { [`milestones.$.${field}`]: now } }
      );
      if (!claimed.modifiedCount) continue;
      const due = new Date(m.dueDate).toLocaleDateString("en-IN", { day: "numeric", month: "short" });
      await notify(conv.project.customers, {
        title: overdue ? "Payment overdue" : "Payment due soon",
        message: `${rupees(m.amountPaise)} for "${m.title}" (${conv.name}) ${overdue ? `was due on ${due}` : `is due on ${due}`}. Pay by UPI or bank transfer and tap "I've paid".`
      });
      sent += 1;
    }
  }
  return sent;
};

module.exports = {
  METHOD_LABELS,
  rupees,
  listMine,
  claimPayment,
  getReceipt,
  invoiceLink,
  adminList,
  adminGet,
  saveSchedule,
  confirmPayment,
  rejectClaim,
  waiveMilestone,
  attachInvoice,
  runReminders
};
