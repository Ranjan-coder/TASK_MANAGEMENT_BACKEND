const ApiResponse = require("../utils/ApiResponse");
const asyncHandler = require("../utils/asyncHandler");
const moderation = require("../services/moderation.service");
const { recordAuditLog } = require("../services/audit.service");

/** GET /moderation/lexicon — the word list devices check against (ETag cached). */
const getLexicon = asyncHandler(async (req, res) => {
  const lexicon = await moderation.getLexicon();
  const etag = `"${lexicon.version}"`;
  res.set("ETag", etag);
  res.set("Cache-Control", "private, no-cache");
  if (req.headers["if-none-match"] === etag) return res.status(304).end();
  res.status(200).json(new ApiResponse(200, lexicon));
});

/** POST /moderation/prevented — anonymous counter: someone chose not to send after the warning. */
const recordPrevented = asyncHandler(async (req, res) => {
  await moderation.recordPrevented();
  res.status(204).end();
});

// ── Admin ──
const listIncidents = asyncHandler(async (req, res) => {
  res.status(200).json(new ApiResponse(200, await moderation.listIncidents(req.query)));
});

const getIncident = asyncHandler(async (req, res) => {
  res.status(200).json(new ApiResponse(200, await moderation.getIncident(req.params.id)));
});

const actOnIncident = asyncHandler(async (req, res) => {
  const { action, note } = req.body;
  const incident =
    action === "resolve" ? await moderation.resolveIncident(req.params.id, req.user, note) : await moderation.requestEvidence(req.params.id, req.user);
  await recordAuditLog({ req, action: `moderation_${action}`, targetType: "System", targetId: incident._id, metadata: { conversation: incident.conversation } });
  res.status(200).json(new ApiResponse(200, await moderation.getIncident(incident._id), action === "resolve" ? "Alert resolved" : "Participants asked for evidence"));
});

const listTerms = asyncHandler(async (req, res) => {
  const [terms, stats] = await Promise.all([moderation.listTermsForAdmin(), moderation.getStats(30)]);
  res.status(200).json(new ApiResponse(200, { terms, stats }));
});

const addTerm = asyncHandler(async (req, res) => {
  const term = await moderation.addTerm(req.body, req.user._id);
  await recordAuditLog({ req, action: "moderation_term_added", targetType: "System", targetId: term._id, metadata: { severity: term.severity } });
  res.status(201).json(new ApiResponse(201, term, "Word added"));
});

const updateTerm = asyncHandler(async (req, res) => {
  const term = await moderation.updateTerm(req.params.id, req.body);
  await recordAuditLog({ req, action: "moderation_term_updated", targetType: "System", targetId: term._id, metadata: req.body });
  res.status(200).json(new ApiResponse(200, term, "Word updated"));
});

const deleteTerm = asyncHandler(async (req, res) => {
  const term = await moderation.deleteTerm(req.params.id);
  await recordAuditLog({ req, action: "moderation_term_deleted", targetType: "System", targetId: term._id, metadata: { display: term.display } });
  res.status(200).json(new ApiResponse(200, null, "Word removed"));
});

module.exports = { getLexicon, recordPrevented, listIncidents, getIncident, actOnIncident, listTerms, addTerm, updateTerm, deleteTerm };
