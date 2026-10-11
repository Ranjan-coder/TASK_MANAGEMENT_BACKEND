const User = require("../models/User");
const ApiError = require("../utils/ApiError");
const ApiResponse = require("../utils/ApiResponse");
const asyncHandler = require("../utils/asyncHandler");
const { recordAuditLog } = require("../services/audit.service");
const { ROLES, ALL_ROLES, ADMIN_ROLES, ADMIN_MANAGEABLE_ROLES, STAFF_ROLES } = require("../config/roles");
const { GRANTABLE_ROLES } = require("../config/permissions");
const org = require("../services/org.service");
const access = require("../services/moduleAccess.service");
const modules = require("../config/modules");

// A conditional write that matched nothing: someone changed the account first
const orStale = (doc) => {
  if (!doc) throw new ApiError(409, "This account was just changed by someone else. Reload and try again.", [{ code: "STALE_VERSION" }]);
  return doc;
};

// Plain snapshot of the fields seats depend on (for before/after comparisons)
const seatView = (u) => (u ? { role: u.role, status: u.status, deletedAt: u.deletedAt, moduleAccess: u.moduleAccess } : null);

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
  // "staff" = the organisation's team (every role except customers); customers have their own screen
  if (req.query.role === "staff") query.role = { $in: STAFF_ROLES };
  else if (typeof req.query.role === "string" && ALL_ROLES.includes(req.query.role)) query.role = req.query.role;
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
  // Seats follow the role (e.g. becoming a customer frees them; becoming an admin takes every module)
  const user = await access.transition(seatView(target), { ...seatView(target), role }, () =>
    // Only if the role is still what we read: two parallel changes can't both move seats
    User.findOneAndUpdate(
      { _id: req.params.id, role: target.role },
      { $set: { role, ...clear, currentSessions: [], refreshTokens: [] }, $inc: { tokenVersion: 1 } }, // role change signs them out everywhere
      { new: true }
    )
      .select("-refreshTokens")
      .then(orStale)
  );
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
  // Inactive people free their seats; reactivating takes them again (refused if full)
  const user = await access.transition(seatView(target), { ...seatView(target), status }, () =>
    // Only if the status is still what we read (otherwise seats would be released twice)
    User.findOneAndUpdate(
      { _id: req.params.id, status: target.status },
      { $set: { status, ...(signOut && { currentSessions: [], refreshTokens: [] }) }, $inc: { tokenVersion: 1 } },
      { new: true }
    )
      .select("-refreshTokens")
      .then(orStale)
  );

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

  // Modules: only a superadmin chooses them (D3 / Phase 4). Otherwise the role's
  // default applies: admins everything, other staff nothing until granted.
  let moduleAccess;
  if (req.body.modules) {
    if (req.user.role !== ROLES.SUPERADMIN) throw new ApiError(403, "Only a superadmin can give access to modules");
    moduleAccess = moduleAccessFrom(req.body.modules, finalRole, req.orgModules);
  }

  const user = new User({
    name,
    email,
    role: finalRole,
    ...orgPatch,
    ...(moduleAccess && { moduleAccess }),
    createdBy: req.user._id,
    // The admin knows the initial password, so the user must replace it before
    // their chat keys are created (the admin could otherwise derive the wrapKey)
    mustChangePassword: true
  });
  user.setDerivedCredential(authKey, kdfSalt);
  await access.transition(null, user, () => user.save());

  // Customers are added by their organisation (module-access-plan.md, M2); a
  // referral code given by the friend is recorded here instead of at sign-up
  if (finalRole === ROLES.CUSTOMER && req.body.referralCode && req.orgModules & require("../config/modules").BIT.referrals) {
    await require("../services/referrals.service").recordSignup({ referred: user, code: req.body.referralCode });
  }

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

  // Seats are released only by the request that actually deleted the account
  await access.transition(seatView(user), null, () => User.findOneAndDelete({ _id: req.params.id }).then(orStale));

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

/** { all, keys } as requested → what is stored (requirements added, org checked). */
const moduleAccessFrom = ({ all = null, keys = [] }, role, orgMask) => {
  if (role === ROLES.CUSTOMER || role === ROLES.SUPERADMIN) {
    throw new ApiError(400, role === ROLES.CUSTOMER ? "Customers use what the organisation has" : "A superadmin always has every module");
  }
  return { all: all === true ? true : all === false ? false : null, keys: all === true ? [] : access.resolveKeys(keys, orgMask) };
};

/**
 * PATCH /users/:id/modules — superadmin gives (or takes away) modules for one person
 * (module-access-plan.md, Phase 4). Seats are claimed atomically; the person's
 * live connections are closed so they reconnect with the new access.
 */
const updateUserModules = asyncHandler(async (req, res) => {
  const target = await User.findById(req.params.id);
  if (!target) throw new ApiError(404, "User not found");
  if (String(target._id) === String(req.user._id)) throw new ApiError(400, "A superadmin always has every module");
  const next = moduleAccessFrom(req.body, target.role, req.orgModules);
  const version = target.moduleAccess?.version || 0;
  const afterAccess = { ...next, version: version + 1 };

  const user = await access.transition(seatView(target), { ...seatView(target), moduleAccess: afterAccess }, async () => {
    // Only if nobody changed this person's modules since we read them
    const updated = await User.findOneAndUpdate(
      { _id: target._id, "moduleAccess.version": version === 0 ? { $in: [0, null] } : version },
      { $set: { moduleAccess: afterAccess } },
      { new: true }
    ).select("-refreshTokens");
    if (!updated) throw new ApiError(409, "Someone else just changed this person's modules. Reload and try again.", [{ code: "STALE_VERSION" }]);
    return updated;
  });
  await require("../sockets").disconnectSessions(user._id);

  await recordAuditLog({
    req,
    action: "user_modules_changed",
    targetType: "User",
    targetId: user._id,
    metadata: {
      before: { all: target.moduleAccess?.all ?? null, keys: target.moduleAccess?.keys || [] },
      after: { all: next.all, keys: next.keys }
    }
  });
  res.status(200).json(new ApiResponse(200, user, "Module access updated"));
});

/** GET /users/:id/modules — what this person holds and can use, for the access panel. */
const getUserModules = asyncHandler(async (req, res) => {
  if (!isId(req.params.id)) throw new ApiError(404, "User not found");
  const target = await User.findById(req.params.id).select("role status moduleAccess orgId");
  if (!target) throw new ApiError(404, "User not found");
  res.status(200).json(
    new ApiResponse(200, {
      all: access.holdsAll(target),
      default: target.moduleAccess?.all == null,
      keys: target.moduleAccess?.keys || [],
      effective: modules.fromMask(access.effectiveUserMask(target, req.orgModules, req.orgCustomerModules)),
      version: target.moduleAccess?.version || 0
    })
  );
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
  updateUserModules,
  getUserModules,
  getAllUsers,
  getUserById,
  createUser,
  updateUser,
  updateProfile,
  updateUserRole,
  updateUserStatus,
  deleteUser
};
