const { MongoClient } = require('mongodb');
const bcrypt = require('bcryptjs');

async function main() {
  const uri = process.env.MONGO_URI;
  if (!uri) {
    console.error('Please set MONGO_URI environment variable.');
    process.exit(1);
  }

  const client = new MongoClient(uri);
  try {
    await client.connect();
    const db = client.db('edunova');
    const usersCollection = db.collection('users');

    const username = process.env.ADMIN_USERNAME || "admin";
    const email = process.env.ADMIN_EMAIL || "admin@edunova.com";

    // The password must NEVER be hardcoded in the repository. Supply it at run
    // time, e.g.:
    //   MONGO_URI="..." ADMIN_PASSWORD="<strong-password>" node scripts/create_admin.js
    // If omitted, a strong random password is generated and printed once.
    let rawPassword = process.env.ADMIN_PASSWORD;
    let generated = false;
    if (!rawPassword) {
      rawPassword = require("crypto").randomBytes(24).toString("base64url");
      generated = true;
    }

    const hashedPassword = await bcrypt.hash(rawPassword, 10);

    const adminData = {
      name: "Administrator",
      username: username,
      email: email,
      password: hashedPassword,
      role: "admin",
      isBlocked: false,
      updatedAt: new Date()
    };

    const res = await usersCollection.updateOne(
      { $or: [{ username: username }, { email: email }] },
      { 
        $set: adminData,
        $setOnInsert: { createdAt: new Date() }
      },
      { upsert: true }
    );

    console.log(
      `✅ Admin user successfully added/updated (${email}). ` +
        `matched=${res.matchedCount} upserted=${res.upsertedCount}`
    );
    if (generated) {
      console.log("🔑 Generated admin password (shown once, store it now):", rawPassword);
    }
  } catch (err) {
    console.error("❌ Failed to create admin user:", err);
  } finally {
    await client.close();
  }
}

main();
