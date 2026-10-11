const express = require("express");
const authMiddleware = require("../../middlewares/auth.middleware");
const validate = require("../../middlewares/validate.middleware");
const { createLimiter } = require("../../middlewares/rateLimiter.middleware");
const asyncHandler = require("../../utils/asyncHandler");
const ApiResponse = require("../../utils/ApiResponse");
const v = require("./planner.validator");
const notes = require("./notes.service");
const todos = require("./todos.service");
const reminders = require("./reminders.service");
const meetings = require("./meetings.service");

/**
 * /api/v1/planner (planner-module-plan.md). The module gate (fed by the manifest's
 * paths) has already checked the organisation and the person. Every handler is
 * owner-scoped by the services; content arrives and leaves encrypted.
 */
const router = express.Router();
router.use(authMiddleware);

const ok = (res, data, message, status = 200) => res.status(status).json(new ApiResponse(status, data, message));
const me = (req) => req.user._id;
// Writes are cheap but unbounded typing/autosave must not flood the database
// Per person, not per network: a whole office behind one IP mustn't share one budget
const writeLimiter = createLimiter({
  windowMs: 60 * 1000,
  max: 120,
  message: "You're saving very fast. Please wait a moment.",
  keyGenerator: (req) => `planner:${req.user?._id || req.ip}`
});
router.use((req, res, next) => (req.method === "GET" ? next() : writeLimiter(req, res, next)));

// ── Vault ──
router.get("/vault", asyncHandler(async (req, res) => ok(res, { wraps: await notes.getVault(me(req)) })));
// Start over when the key can't be recovered: needs an explicit confirmation word, and is audited
router.delete(
  "/vault",
  validate(v.vaultResetSchema),
  asyncHandler(async (req, res) => {
    // Re-check the password: wiping the Planner needs more than a session
    const User = require("../../models/User");
    const user = await User.findById(me(req)).select("+password +failedLoginAttempts +lockUntil");
    if (user.isLocked() || !(await user.verifyCredential({ authKey: req.body.authKey, password: req.body.password }))) {
      await user.incrementLoginAttempts();
      throw new (require("../../utils/ApiError"))(401, "That password is incorrect.", [{ code: "WRONG_PASSWORD" }]);
    }
    const removed = await notes.resetVault(me(req));
    await require("../../services/audit.service").recordAuditLog({ req, action: "planner_reset", targetType: "User", targetId: me(req), metadata: removed });
    ok(res, removed, "Your Planner was reset");
  })
);
router.put("/vault", validate(v.vaultPutSchema), asyncHandler(async (req, res) => ok(res, { wraps: await notes.addVaultWrap(me(req), req.body) })));

// ── Notes ──
router.get("/notes", validate(v.notesListSchema), asyncHandler(async (req, res) => ok(res, await notes.listNotes(me(req), req.query))));
router.post("/notes", validate(v.noteCreateSchema), asyncHandler(async (req, res) => ok(res, await notes.createNote(me(req), req.body), "Note created", 201)));
router.patch("/notes/:id", validate(v.noteUpdateSchema), asyncHandler(async (req, res) => ok(res, await notes.updateNote(me(req), req.params.id, req.body))));
router.delete("/notes/:id", validate(v.idOnlySchema), asyncHandler(async (req, res) => ok(res, await notes.deleteNote(me(req), req.params.id), "Note deleted")));

// ── Todo lists and items ──
router.get("/lists", asyncHandler(async (req, res) => ok(res, await todos.listLists(me(req)))));
router.post("/lists", validate(v.listCreateSchema), asyncHandler(async (req, res) => ok(res, await todos.createList(me(req), req.body), "List created", 201)));
router.patch("/lists/:id", validate(v.listUpdateSchema), asyncHandler(async (req, res) => ok(res, await todos.updateList(me(req), req.params.id, req.body))));
router.post("/lists/:id/move", validate(v.listMoveSchema), asyncHandler(async (req, res) => ok(res, await todos.moveList(me(req), req.params.id, req.body))));
router.delete("/lists/:id", validate(v.idOnlySchema), asyncHandler(async (req, res) => ok(res, await todos.deleteList(me(req), req.params.id), "List deleted")));
router.get("/lists/:id/items", validate(v.idOnlySchema), asyncHandler(async (req, res) => ok(res, await todos.listItems(me(req), req.params.id))));
router.post("/lists/:id/items", validate(v.itemCreateSchema), asyncHandler(async (req, res) => ok(res, await todos.createItem(me(req), req.params.id, req.body), "Added", 201)));
router.patch("/items/:id", validate(v.itemUpdateSchema), asyncHandler(async (req, res) => ok(res, await todos.updateItem(me(req), req.params.id, req.body))));
router.post("/items/:id/move", validate(v.itemMoveSchema), asyncHandler(async (req, res) => ok(res, await todos.moveItem(me(req), req.params.id, req.body))));
router.delete("/items/:id", validate(v.idOnlySchema), asyncHandler(async (req, res) => ok(res, await todos.deleteItem(me(req), req.params.id), "Deleted")));
router.get("/todos/due", validate(v.rangeSchema), asyncHandler(async (req, res) => ok(res, await todos.dueItems(me(req), req.query))));

// ── Reminders ──
router.get("/reminders", validate(v.reminderListSchema), asyncHandler(async (req, res) => ok(res, await reminders.listReminders(me(req), req.query))));
router.post("/reminders", validate(v.reminderCreateSchema), asyncHandler(async (req, res) => ok(res, await reminders.createReminder(me(req), req.body), "Reminder set", 201)));
router.patch("/reminders/:id", validate(v.reminderUpdateSchema), asyncHandler(async (req, res) => ok(res, await reminders.updateReminder(me(req), req.params.id, req.body))));
router.post("/reminders/:id/snooze", validate(v.snoozeSchema), asyncHandler(async (req, res) => ok(res, await reminders.snooze(me(req), req.params.id, req.body), "Snoozed")));
router.post("/reminders/:id/done", validate(v.idOnlySchema), asyncHandler(async (req, res) => ok(res, await reminders.markDone(me(req), req.params.id))));
router.delete("/reminders/:id", validate(v.idOnlySchema), asyncHandler(async (req, res) => ok(res, await reminders.deleteReminder(me(req), req.params.id), "Deleted")));

// ── Meetings ──
router.get("/meetings", validate(v.meetingRangeSchema), asyncHandler(async (req, res) => ok(res, await meetings.listMeetings(me(req), req.query))));
router.get("/meetings/:id", validate(v.idOnlySchema), asyncHandler(async (req, res) => ok(res, await meetings.getMeeting(me(req), req.params.id))));
// Each meeting can notify and email up to 50 people: at most 30 new meetings per person per hour
const meetingLimiter = createLimiter({ windowMs: 60 * 60 * 1000, max: 30, message: "You've created a lot of meetings this hour. Please wait a bit." });
router.post("/meetings", meetingLimiter, validate(v.meetingCreateSchema), asyncHandler(async (req, res) => ok(res, await meetings.createMeeting(req, req.body), "Meeting created", 201)));
router.patch("/meetings/:id", validate(v.meetingUpdateSchema), asyncHandler(async (req, res) => ok(res, await meetings.updateMeeting(req, req.params.id, req.body))));
router.post("/meetings/:id/respond", validate(v.respondSchema), asyncHandler(async (req, res) => ok(res, await meetings.respond(me(req), req.params.id, req.body.response))));
router.delete("/meetings/:id", validate(v.idOnlySchema), asyncHandler(async (req, res) => ok(res, await meetings.cancelMeeting(req, req.params.id), "Meeting cancelled")));
router.get("/people", validate(v.peopleSchema), asyncHandler(async (req, res) => ok(res, await meetings.searchPeople(req, req.query.q))));
router.get("/availability", validate(v.availabilitySchema), asyncHandler(async (req, res) => ok(res, await meetings.availability(req, req.query))));

module.exports = router;
