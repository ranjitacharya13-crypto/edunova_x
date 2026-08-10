const { MongoClient } = require("mongodb");
const bcrypt = require("bcryptjs");

/**
 * Explicit administrator bootstrap utility.
 * All identity and password fields are required at invocation time; no default
 * account and no generated password are written to application logs.
 */
async function main() {
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  const username = String(process.env.ADMIN_USERNAME || "").trim();
  const email = String(process.env.ADMIN_EMAIL || "").trim().toLowerCase();
  const password = String(process.env.ADMIN_PASSWORD || "");

  if (!uri || !username || !email || !password) {
    console.error("Set MONGO_URI (or MONGODB_URI), ADMIN_USERNAME, ADMIN_EMAIL, and ADMIN_PASSWORD before running this script.");
    process.exit(1);
  }
  if (password.length < 12) {
    console.error("ADMIN_PASSWORD must contain at least 12 characters.");
    process.exit(1);
  }

  const client = new MongoClient(uri);
  try {
    await client.connect();
    const db = client.db(process.env.MONGO_DB_NAME || "edunova");
    const users = db.collection("users");
    const adminData = {
      name: String(process.env.ADMIN_NAME || "Administrator").trim(),
      username,
      email,
      password: await bcrypt.hash(password, 12),
      role: "admin",
      isBlocked: false,
      updatedAt: new Date(),
    };
    const result = await users.updateOne(
      { $or: [{ username }, { email }] },
      { $set: adminData, $setOnInsert: { createdAt: new Date() } },
      { upsert: true }
    );
    console.log(`Admin account updated. matched=${result.matchedCount} upserted=${result.upsertedCount}`);
  } catch (error) {
    console.error("Failed to create or update admin:", error.message);
    process.exitCode = 1;
  } finally {
    await client.close();
  }
}

main();
