// Shared authorization filters. Model output never supplies identity or access.
const mongoose = require("mongoose");
const normalizeRoom = (value) => String(value || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const roomsFor = (user) => (user.enrolledClasses || []).map(normalizeRoom).filter(Boolean);
const identity = (user) => user._id || user.id;
const isStaff = (user) => ["teacher", "admin"].includes(user.role);
const publicMaterials = { "metadata.ownerId": null, "metadata.classId": null, "metadata.visibility": { $ne: "private" } };
const legacyShared = { ownerId: null, classId: null };
function assignmentAccess(user) {
  const ownerId = identity(user);
  if (user.role === "admin") return {};
  return { $or: [
    { ownerId },
    { ownerId: null, visibility: { $ne: "private" }, room: { $in: [...roomsFor(user), "general"] } },
    ...(isStaff(user) ? [{ "createdBy.id": ownerId }] : []),
  ] };
}
function materialAccess(user) {
  // Existing GridFS materials are shared educational resources. New scoped
  // files are visible only to their owner or enrolled class, never all users.
  return { $or: [
    { "metadata.ownerId": String(identity(user)) },
    { "metadata.visibility": { $ne: "private" }, "metadata.classId": { $in: roomsFor(user) } },
    { "metadata.visibility": { $ne: "private" }, "metadata.classId": null, "metadata.ownerId": null },
  ] };
}
function requireDatabase() {
  if (mongoose.connection.readyState !== 1) {
    const error = new Error("EduNova database is unavailable");
    error.code = "DATABASE_FAILED";
    error.status = 503;
    throw error;
  }
}
function httpError(code, message, status = 400) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}
const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
module.exports = { publicMaterials, normalizeRoom, roomsFor, identity, isStaff, legacyShared, assignmentAccess, materialAccess, requireDatabase, httpError, escapeRegex };
