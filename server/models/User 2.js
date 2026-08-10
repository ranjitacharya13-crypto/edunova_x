const mongoose = require("mongoose");

const userSchema = new mongoose.Schema(
  {
    name: String,
    dob: String,
    gender: String,
    username: { type: String, unique: true },
    email: { type: String, unique: true, required: true },
    password: { type: String, required: true },
    role: { type: String, enum: ["admin", "teacher", "student"], default: "student" },
    isBlocked: { type: Boolean, default: false },
  },
  { timestamps: true }
);

// Export the model
module.exports = mongoose.model("User", userSchema);
