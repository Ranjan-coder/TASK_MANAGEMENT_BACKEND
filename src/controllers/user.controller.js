const User = require("../models/User");
const ApiError = require("../utils/ApiError");
const ApiResponse = require("../utils/ApiResponse");
const asyncHandler = require("../utils/asyncHandler");
const { recordAuditLog } = require("../services/audit.service");
const { ROLES, ALL_ROLES, ADMIN_ROLES, ADMIN_MANAGEABLE_ROLES } = require("../config/roles");
const { GRANTABLE_ROLES } = require("../config/permissions");
const org = require("../services/org.service");

const isId = (v) => typeof v === "string" && /^[a-f0-9]{24}$/i.test(v);
const ORG_AUDIT_FIELDS = ["department", "designation", "reportsTo"];
const pick = (obj, keys) => Object.fromEntries(keys.map((k) => [k, obj?.[k] ? String(obj[k]) : null]));

// Escape user input before using it inside a RegExp (prevents regex injection / ReDoS)
const escapeRegex = (value) => String(value).slice(0, 100).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const isAdminRole = (role) => ADMIN_ROLES.includes(role);

/**
 * An admin may only manage user/marketing/customer accounts; only a superadmin
 * may manage admins. Nobody manages superadmins through these endpoints except
 * another superadmin (and never themselves, to avoid accidental lockout).
 */
const assertCanManage = (actor, target) => {
  if (actor._id.toString() === target._id.toString()) {
    throw new ApiError(400, "Use your profile settings to change your own account");
  }
  if (actor.role === ROLES.SUPERADMIN) return;
  if (actor.role === ROLES.ADMIN && ADMIN_MANAGEABLE_ROLES.includes(target.role)) return;
  throw new ApiError(403, "You do not have permission to manage this account");
};

const getAllUsers = asyncHandler(async (req, res) => {
  const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
  const skip = (page - 1) * limit;

  const query = {};
  if (typeof req.query.role === "string" && ALL_ROLES.includes(req.query.role)) query.role = req.query.role;
  if (typeof req.query.status === "string") query.status = req.query.status;
  if (typeof req.query.department === "string") query.department = req.query.department;
  if (isId(req.query.departmentId)) query.departmentId = req.query.departmentId;
  if (isId(req.query.designationId)) query.designationId = req.query.designationId;
  if (isId(req.query.reportsTo)) query.reportsTo = req.query.reportsTo;
  if (typeof req.query.search === "string" && req.query.search.trim()) {
    const safe = escapeRegex(req.query.search.trim());
    query.$or = [
      { name: { $regex: safe, $options: "i" } },
      { email: { $regex: safe, $options: "i" } }
    ];
  }

  const [users, total] = await Promise.all([
    User.find(query).select("-refreshTokens").sort({ createdAt: -1 }).skip(skip).limit(limit),
    User.countDocuments(query)
  ]);

  res.status(200).json(
    new ApiResponse(200, users, "Users fetched successfully", {
      page,
      limit,
      total,
      pages: Math.ceil(total / limit)
    })
  );
});

const getUserById = asyncHandler(async (req, res) => {
  // IDOR guard: only the account owner or an admin may read a full user profile
  if (req.params.id !== req.user._id.toString() && !isAdminRole(req.user.role)) {
    throw new ApiError(403, "You do not have permission to view this user");
  }

  const user = await User.findById(req.params.id).select("-refreshTokens").populate("reportsTo", "name avatarUrl designation");
  if (!user) {
    throw new ApiError(404, "User not found");
  }
  res.status(200).json(new ApiResponse(200, user, "User fetched successfully"));
});

const updateUser = asyncHandler(async (req, res) => {
  const { name, avatarUrl, availability, departmentId, designationId, reportsTo } = req.body;

  const target = await User.findById(req.params.id);
  if (!target) {
    throw new ApiError(404, "User not found");
  }
  assertCanManage(req.user, target);

  // Department / designation / manager: list membership, seniority and cycle checks
  const orgPatch = await org.resolveAssignment({ actor: req.user, target, targetRole: target.role, departmentId, designationId, reportsTo });
  const updateData = { ...orgPatch };
  if (name !== undefined) updateData.name = name;
  if (avatarUrl !== undefined) updateData.avatarUrl = avatarUrl;
  if (availability !== undefined && target.role !== ROLES.CUSTOMER) {
    updateData.availability = {
      status: availability.status,
      until: availability.status === "on_leave" ? availability.until || null : null
    };
  }

  const user = await User.findByIdAndUpdate(
    req.params.id,
    { $set: updateData },
    { new: true, runValidators: true }
  ).select("-refreshTokens");

  await recordAuditLog({
    req,
    action: "user_updated",
    targetType: "User",
    targetId: user._id,
    metadata: {
      updatedFields: Object.keys(updateData),
      ...(Object.keys(orgPatch).length && { before: pick(target, ORG_AUDIT_FIELDS), after: pick(user, ORG_AUDIT_FIELDS) })
    }
  });

  res.status(200).json(new ApiResponse(200, user, "User updated successfully"));
});

const updateUserRole = asyncHandler(async (req, res) => {
  const { role } = req.body;
  if (!ALL_ROLES.includes(role)) {
    throw new ApiError(400, "Invalid role specified");
  }

  const target = await User.findById(req.params.id);
  if (!target) {
    throw new ApiError(404, "User not found");
  }
  assertCanManage(req.user, target);

  // Customers hold no department/designation/manager; add-ons only on grantable roles
  const clear = {
    ...(role === ROLES.CUSTOMER && { departmentId: null, department: "", designationId: null, designation: "", reportsTo: null }),
    ...(!GRANTABLE_ROLES.includes(role) && { permissions: [] })
  };
  const user = await User.findByIdAndUpdate(
    req.params.id,
    { $set: { role, ...clear, currentSessions: [], refreshTokens: [] }, $inc: { tokenVersion: 1 } }, // role change signs them out everywhere
    { new: true }
  ).select("-refreshTokens");
  await require("../sockets").disconnectSessions(req.params.id);

  if (!user) {
    throw new ApiError(404, "User not found");
  }

  await recordAuditLog({
    req,
    action: "user_role_changed",
    targetType: "User",
    targetId: user._id,
    metadata: { oldRole: target.role, newRole: role }
  });

  res.status(200).json(new ApiResponse(200, user, `User role changed to ${role}`));
});

const updateUserStatus = asyncHandler(async (req, res) => {
  const { status } = req.body;
  if (!["active", "inactive", "suspended"].includes(status)) {
    throw new ApiError(400, "Invalid status specified");
  }

  const target = await User.findById(req.params.id);
  if (!target) {
    throw new ApiError(404, "User not found");
  }
  assertCanManage(req.user, target);

  // Suspending or deactivating signs the person out everywhere, including open live connections
  const signOut = status !== "active";
  const user = await User.findByIdAndUpdate(
    req.params.id,
    { $set: { status, ...(signOut && { currentSessions: [], refreshTokens: [] }) }, $inc: { tokenVersion: 1 } },
    { new: true }
  ).select("-refreshTokens");

  if (!user) {
    throw new ApiError(404, "User not found");
  }
  if (signOut) await require("../sockets").disconnectSessions(user._id);

  await recordAuditLog({
    req,
    action: "user_status_changed",
    targetType: "User",
    targetId: user._id,
    metadata: { newStatus: status }
  });

  res.status(200).json(new ApiResponse(200, user, `User status changed to ${status}`));
});

const createUser = asyncHandler(async (req, res) => {
  const { name, email, authKey, kdfSalt, role, departmentId, designationId, reportsTo } = req.body;
  const finalRole = role || ROLES.USER;

  // Admins can create user/marketing/customer accounts; only Super Admins can create admins or leadership
  if (req.user.role === ROLES.ADMIN && !ADMIN_MANAGEABLE_ROLES.includes(finalRole)) {
    throw new ApiError(403, "Admins can only create user, marketing or customer accounts");
  }
  const orgPatch = await org.resolveAssignment({ actor: req.user, target: null, targetRole: finalRole, departmentId, designationId, reportsTo });

  const existingUser = await User.findOne({ email });
  if (existingUser) {
    throw new ApiError(409, "A user with this email already exists");
  }

  const user = new User({
    name,
    email,
    role: finalRole,
    ...orgPatch,
    createdBy: req.user._id,
    // The admin knows the initial password, so the user must replace it before
    // their chat keys are created (the admin could otherwise derive the wrapKey)
    mustChangePassword: true
  });
  user.setDerivedCredential(authKey, kdfSalt);
  await user.save();

  await recordAuditLog({
    req,
    action: "user_created",
    targetType: "User",
    targetId: user._id,
    metadata: { email, role: user.role, department: user.department || null, designation: user.designation || null }
  });

  const userResponse = user.toObject();
  delete userResponse.password;

  res.status(201).json(new ApiResponse(201, userResponse, "User created successfully"));
});

const deleteUser = asyncHandler(async (req, res) => {
  if (req.params.id === req.user._id.toString()) {
    throw new ApiError(400, "You cannot delete your own account");
  }

  const user = await User.findById(req.params.id);
  if (!user) {
    throw new ApiError(404, "User not found");
  }

  // Prevent deletion of other super admins
  if (user.role === "superadmin" && req.user.role === "superadmin") {
    throw new ApiError(403, "Cannot delete another Super Admin account");
  }

  await User.findByIdAndDelete(req.params.id);

  await recordAuditLog({
    req,
    action: "user_deleted",
    targetType: "User",
    targetId: user._id,
    metadata: { email: user.email, role: user.role }
  });

  res.status(200).json(new ApiResponse(200, null, "User permanently deleted"));
});

/** PATCH /users/:id/permissions — superadmin grants add-on permissions (config/permissions.js). */
const updateUserPermissions = asyncHandler(async (req, res) => {
  const target = await User.findById(req.params.id);
  if (!target) throw new ApiError(404, "User not found");
  if (!GRANTABLE_ROLES.includes(target.role)) {
    throw new ApiError(400, "Add-on permissions are for user, marketing and leadership accounts (admins already have them)");
  }
  const before = [...(target.permissions || [])];
  const user = await User.findByIdAndUpdate(req.params.id, { $set: { permissions: req.body.permissions } }, { new: true }).select("-refreshTokens");
  await recordAuditLog({
    req,
    action: "user_permissions_changed",
    targetType: "User",
    targetId: user._id,
    metadata: { before, after: req.body.permissions }
  });
  // Takes effect on their next request (the account is re-read on every request)
  res.status(200).json(new ApiResponse(200, user, "Permissions updated"));
});

const updateProfile = asyncHandler(async (req, res) => {
  const { name, avatarUrl, availability, notificationPrefs, departmentId, designationId, reportsTo } = req.body;
  const updateData = {};
  if (departmentId !== undefined || designationId !== undefined || reportsTo !== undefined) {
    if (req.user.role !== ROLES.SUPERADMIN) {
      throw new ApiError(403, "Your department, designation and manager are set by an admin", [{ code: "ORG_SELF_ASSIGN" }]);
    }
    Object.assign(updateData, await org.resolveAssignment({ actor: req.user, target: req.user, targetRole: req.user.role, departmentId, designationId, reportsTo }));
  }
  if (notificationPrefs !== undefined && req.user.role === ROLES.CUSTOMER) {
    if ((notificationPrefs.whatsapp || notificationPrefs.sms) && !req.user.phoneVerified) {
      throw new ApiError(400, "Verify your mobile number first");
    }
    updateData.notificationPrefs = { ...notificationPrefs, updatedAt: new Date() };
  }
  if (name !== undefined) updateData.name = name;
  if (avatarUrl !== undefined) updateData.avatarUrl = avatarUrl;
  // Department and designation are assigned by an admin (managed lists, seniority
  // rules): nobody can give themselves a title such as "CEO" from their profile.
  if (availability !== undefined && req.user.role !== ROLES.CUSTOMER) {
    updateData.availability = {
      status: availability.status,
      until: availability.status === "on_leave" ? availability.until || null : null
    };
  }

  const user = await User.findByIdAndUpdate(
    req.user._id,
    { $set: updateData },
    { new: true, runValidators: true }
  ).select("-refreshTokens");

  if (!user) {
    throw new ApiError(404, "User not found");
  }

  await recordAuditLog({
    req,
    actorId: user._id,
    action: "profile_updated",
    targetType: "User",
    targetId: user._id,
    metadata: { updatedFields: Object.keys(updateData) }
  });

  res.status(200).json(new ApiResponse(200, user, "Profile updated successfully"));
});

module.exports = {
  updateUserPermissions,
  getAllUsers,
  getUserById,
  createUser,
  updateUser,
  updateProfile,
  updateUserRole,
  updateUserStatus,
  deleteUser
};
