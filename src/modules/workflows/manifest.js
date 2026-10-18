/**
 * Project workflows module manifest (project-workflow-plan.md). Pure data; code is
 * loaded lazily.
 *
 * The engine (moving projects through their stages) is part of Projects and always
 * works: projects follow their company's workflow even when this module is off.
 * This module is the editor: building, publishing and updating the workflow, and
 * the reports and alerts that come with it.
 */
module.exports = {
  key: "workflows",
  bit: 16, // append-only: never reuse or renumber
  label: "Project workflow",
  description: "The company's own project stages and sub-stages: editor, versions, stage alerts and time-in-stage reports.",
  requires: ["projects"],
  defaultOn: true,
  audience: "staff",
  paths: ["/workflow"],
  pages: ["/workflow"],
  events: [],
  router: () => require("./workflows.routes"),
  jobs: [{ label: "WorkflowOverdue", run: () => require("./overdue.service").processDue() }]
};
