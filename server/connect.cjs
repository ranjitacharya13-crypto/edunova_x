// connect.cjs — quick MongoDB connectivity test (LOCAL DEV / ADMIN USE ONLY)
// Usage:  MONGO_URI="mongodb+srv://..." node connect.cjs
const { MongoClient } = require("mongodb");

async function main() {
  const uri = process.env.MONGO_URI;
  if (!uri) {
    console.error("MONGO_URI is not set. Run with: MONGO_URI=\"<atlas-uri>\" node connect.cjs");
    process.exit(1);
  }

  const client = new MongoClient(uri);
  try {
    await client.connect();
    console.log("edunova_x database connected");
  } catch (error) {
    console.error("❌ MongoDB connection error:", error);
    process.exitCode = 1;
  } finally {
    await client.close();
  }
}

main().catch(console.error);
