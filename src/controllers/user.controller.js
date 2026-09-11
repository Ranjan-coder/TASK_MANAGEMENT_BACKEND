const crypto = require("crypto");
const User = require("../models/User");
const ApiError = require("../utils/ApiError");
const ApiResponse = require("../utils/ApiResponse");
const asyncHandler = require("../utils/asyncHandler");
const { recordAuditLog } = require("../services/audit.service");

const getAllUsers = asyncHandler(async (req, res) => {
  const page = parseInt(req.query.page, 10) || 1;
  const limit = parseInt(req.query.limit, 10) || 20;
  const skip = (page - 1) * limit;

  const query = {};
  if (req.query.role) query.role = req.query.role;
  if (req.query.status) query.status = req.query.status;
  if (req.query.department) query.department = req.query.department;
  if (req.query.search) {
    query.$or = [
      { name: { $regex: req.query.search, $options: "i" } },
      { email: { $regex: req.query.search, $options: "i" } }
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
  const user = await User.findById(req.params.id).select("-refreshTokens");
  if (!user) {
    throw new ApiError(404, "User not found");
  }
  res.status(200).json(new ApiResponse(200, user, "User fetched successfully"));
});

const updateUser = asyncHandler(async (req, res) => {
  const { name, department, designation, avatarUrl } = req.body;

  const user = await User.findByIdAndUpdate(
    req.params.id,
    { $set: { name, department, designation, avatarUrl } },
    { new: true, runValidators: true }
  ).select("-refreshTokens");

  if (!user) {
    throw new ApiError(404, "User not found");
  }

  await recordAuditLog({
    req,
    action: "user_updated",
    targetType: "User",
    targetId: user._id,
    metadata: { updatedFields: { name, department, designation } }
  });

  res.status(200).json(new ApiResponse(200, user, "User updated successfully"));
});

const updateUserRole = asyncHandler(async (req, res) => {
  const { role } = req.body;
  if (!["superadmin", "admin", "user"].includes(role)) {
    throw new ApiError(400, "Invalid role specified");
  }

  const user = await User.findByIdAndUpdate(
    req.params.id,
    { $set: { role }, $inc: { tokenVersion: 1 } }, // invalidate sessions upon role change
    { new: true }
  ).select("-refreshTokens");

  if (!user) {
    throw new ApiError(404, "User not found");
  }

  await recordAuditLog({
    req,
    action: "user_role_changed",
    targetType: "User",
    targetId: user._id,
    metadata: { newRole: role }
  });

  res.status(200).json(new ApiResponse(200, user, `User role changed to ${role}`));
});

const updateUserStatus = asyncHandler(async (req, res) => {
  const { status } = req.body;
  if (!["active", "inactive", "suspended"].includes(status)) {
    throw new ApiError(400, "Invalid status specified");
  }

  const user = await User.findByIdAndUpdate(
    req.params.id,
    { $set: { status }, $inc: { tokenVersion: 1 } },
    { new: true }
  ).select("-refreshTokens");

  if (!user) {
    throw new ApiError(404, "User not found");
  }

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
  const { name, email, password, role, department, designation } = req.body;

  // Admins can only create regular users; Super Admins can create any role
  if (req.user.role === "admin" && role && role !== "user") {
    throw new ApiError(403, "Admins can only create accounts with 'user' role");
  }

  const existingUser = await User.findOne({ email });
  if (existingUser) {
    throw new ApiError(409, "A user with this email already exists");
  }

  const user = await User.create({
    name,
    email,
    password: password || crypto.randomBytes(16).toString("hex"), // temp password if not provided
    role: role || "user",
    department,
    designation,
    createdBy: req.user._id
  });

  await recordAuditLog({
    req,
    action: "user_created",
    targetType: "User",
    targetId: user._id,
    metadata: { email, role: user.role }
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

const updateProfile = asyncHandler(async (req, res) => {
  const { name, department, designation, avatarUrl } = req.body;
  const updateData = {};
  if (name !== undefined) updateData.name = name;
  if (department !== undefined) updateData.department = department;
  if (designation !== undefined) updateData.designation = designation;
  if (avatarUrl !== undefined) updateData.avatarUrl = avatarUrl;

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
  getAllUsers,
  getUserById,
  createUser,
  updateUser,
  updateProfile,
  updateUserRole,
  updateUserStatus,
  deleteUser
};
