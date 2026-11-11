/**
 * Project stages (the customer's timeline) and the rules for moving between them.
 * Single source for the model, the service and the API.
 *
 * The stages form an ordered list; INDEX maps each key to its position, so every
 * lookup and comparison is O(1). `planTransition` is a pure function (no database),
 * which keeps the rules in one place and makes them easy to test.
 *
 * Rules:
 *   next  (one step forward)  — the project's lead/backup designer, manager or an admin
 *   back  (one step back)     — same people, with a reason the customer will see
 *   jump  (skip ahead/behind) — admins only, with a reason
 *   Projects that are on hold or completed don't move until an admin reopens them.
 */
const STAGES = Object.freeze([
  { key: "consultation", label: "Consultation" },
  { key: "site_measurement", label: "Site measurement" },
  { key: "design", label: "Design" },
  { key: "quotation", label: "Quotation" },
  { key: "production", label: "Production" },
  { key: "installation", label: "Installation" },
  { key: "handover", label: "Handover" }
]);

const STAGE_KEYS = Object.freeze(STAGES.map((s) => s.key));
const INDEX = new Map(STAGE_KEYS.map((k, i) => [k, i]));
const LABELS = Object.freeze(Object.fromEntries(STAGES.map((s) => [s.key, s.label])));
const FIRST = STAGE_KEYS[0];
const LAST = STAGE_KEYS[STAGE_KEYS.length - 1];
const MIN_REASON = 5;

class StageRuleError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

/** Current stage of a project (older projects may have none stored). */
const currentStage = (project) => (INDEX.has(project?.stage) ? project.stage : FIRST);

const nextStage = (stage) => STAGE_KEYS[(INDEX.get(stage) ?? 0) + 1] ?? null;
const prevStage = (stage) => STAGE_KEYS[(INDEX.get(stage) ?? 0) - 1] ?? null;

/**
 * Decides whether `from → to` is allowed and what kind of move it is.
 * @returns {{ kind: "same" | "next" | "back" | "jump", steps: number }}
 * @throws {StageRuleError}
 */
const planTransition = ({ from, to, status = "active", isAdmin = false, note = "" }) => {
  if (!INDEX.has(to)) throw new StageRuleError("STAGE_UNKNOWN", "Unknown stage");
  const a = INDEX.get(INDEX.has(from) ? from : FIRST);
  const b = INDEX.get(to);
  const steps = b - a;
  if (steps === 0) return { kind: "same", steps };

  if (status === "completed") throw new StageRuleError("PROJECT_COMPLETED", "This project is completed. An admin can reopen it to change the stage.", 409);
  if (status === "on_hold") throw new StageRuleError("PROJECT_ON_HOLD", "This project is on hold. Resume it first.", 409);

  const hasReason = String(note || "").trim().length >= MIN_REASON;
  if (steps === 1) return { kind: "next", steps };
  if (steps === -1) {
    if (!hasReason) throw new StageRuleError("STAGE_REASON_REQUIRED", "Say why the project is going back a stage (the customer will see it).");
    return { kind: "back", steps };
  }
  if (!isAdmin) throw new StageRuleError("STAGE_SKIP_ADMIN_ONLY", "Stages move one step at a time. Only an admin can skip stages.", 403);
  if (!hasReason) throw new StageRuleError("STAGE_REASON_REQUIRED", "Say why stages are being skipped.");
  return { kind: "jump", steps };
};

module.exports = {
  STAGES,
  STAGE_KEYS,
  LABELS,
  FIRST,
  LAST,
  MIN_REASON,
  StageRuleError,
  currentStage,
  nextStage,
  prevStage,
  planTransition
};
