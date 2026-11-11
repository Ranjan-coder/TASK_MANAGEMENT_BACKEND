/**
 * Planner module manifest (planner-module-plan.md). Pure data: the registry reads
 * it at start-up. Code that pulls in models and services (router, jobs) is loaded
 * lazily, so reading the catalog never creates a require cycle.
 */
module.exports = {
  key: "planner",
  bit: 14, // append-only: never reuse or renumber
  label: "Planner",
  description: "Private notes, todo lists, reminders and meeting invites. End-to-end encrypted.",
  requires: [],
  defaultOn: true, // every organisation and every staff member, unless switched off
  audience: "staff", // customers only if their organisation opens it to them
  customerOptIn: true,
  paths: ["/planner"], // API paths (relative to /api/v1) that belong to this module
  pages: ["/planner"], // app screens that belong to this module
  events: ["planner:"], // live (socket) events sent by clients
  router: () => require("./planner.routes"),
  jobs: [
    { label: "PlannerReminders", run: () => require("./reminders.service").processDue() },
    { label: "PlannerMeetingReminders", run: () => require("./meetings.service").processDue() }
  ]
};
