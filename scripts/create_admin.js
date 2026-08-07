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

    const username = "admin";
    const rawPassword = "admin@1215";
    const email = "admin@edunova.com";

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

    console.log("✅ Admin user successfully added/updated in database:", res);
  } catch (err) {
    console.error("❌ Failed to create admin user:", err);
  } finally {
    await client.close();
  }
}

main();
