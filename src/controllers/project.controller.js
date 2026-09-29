const ApiResponse = require("../utils/ApiResponse");
const asyncHandler = require("../utils/asyncHandler");
const projectService = require("../services/project.service");
const { recordAuditLog } = require("../services/audit.service");

const listProjects = asyncHandler(async (req, res) => {
  res.status(200).json(new ApiResponse(200, await projectService.listProjects({ status: req.query.status })));
});

const getProject = asyncHandler(async (req, res) => {
  res.status(200).json(new ApiResponse(200, await projectService.getProject(req.params.id)));
});

const createProject = asyncHandler(async (req, res) => {
  const project = await projectService.createProject({ actor: req.user, ...req.body });
  await recordAuditLog({
    req,
    action: "project_created",
    targetType: "System",
    targetId: project._id,
    metadata: { name: project.name, customers: req.body.customerIds, leadDesigner: req.body.leadDesignerId }
  });
  res.status(201).json(new ApiResponse(201, project, "Project chat created"));
});

const updateProject = asyncHandler(async (req, res) => {
  const { project, removed, added } = await projectService.updateProject(req.params.id, { actor: req.user, ...req.body });
  await recordAuditLog({
    req,
    action: "project_updated",
    targetType: "System",
    targetId: project._id,
    metadata: { removed, added, status: project.project.status }
  });
  res.status(200).json(new ApiResponse(200, project, "Project updated"));
});

module.exports = { listProjects, getProject, createProject, updateProject };
