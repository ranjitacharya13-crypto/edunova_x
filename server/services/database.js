// server/services/database.js
//
// Single place that answers "is MongoDB usable right now?".
//
// Why this exists: without it a request that arrives while the Atlas
// connection is down (or still connecting) is answered by mongoose's query
// buffering — the query times out and the route collapses the failure into a
// generic error. Authentication must never report a database outage as
// "Invalid credentials", so /api/auth/* checks this FIRST and answers
// 503 + a database-specific message instead.
//
// `mongoose.connection.readyState` values:
//   0 disconnected · 1 connected · 2 connecting · 3 disconnecting · 99 uninitialized
const mongoose = require("mongoose");

const READY_STATE = 1;

function isDatabaseReady() {
  return mongoose.connection.readyState === READY_STATE;
}

function databaseState() {
  switch (mongoose.connection.readyState) {
    case 0:
      return "disconnected";
    case 1:
      return "connected";
    case 2:
      return "connecting";
    case 3:
      return "disconnecting";
    default:
      return "uninitialized";
  }
}

module.exports = { isDatabaseReady, databaseState, READY_STATE };
