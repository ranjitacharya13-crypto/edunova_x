// server/middleware/auth.js
const jwt = require('jsonwebtoken');
const User = require('../models/User');
require('dotenv').config();

module.exports = async function (req, res, next) {
  const authHeader = req.headers['authorization'] || req.headers['Authorization'];
  const token = authHeader && authHeader.startsWith('Bearer ') ? authHeader.split(' ')[1] : null;
  if (!token) return res.status(401).json({ error: 'No token provided' });

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    // attach minimal user info
    const user = await User.findById(decoded.id).select('-password');
    if (!user || user.isBlocked) return res.status(401).json({ error: 'Invalid or blocked user' });
    req.user = { id: user._id, email: user.email, role: user.role, name: user.name, enrolledClasses: user.enrolledClasses || [], subjects: user.subjects || [], timezone: user.timezone || "UTC" };
    next();
  } catch (e) {
    console.warn('AUTH_FAILED', e.name);
    return res.status(401).json({ error: 'Invalid token' });
  }
};
