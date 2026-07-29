// connect.cjs
const { MongoClient } = require("mongodb");

async function main() {
  const uri = "mongodb+srv://ranjit5201314_db_user:admin12345@cluster1edunovax.8q5lafw.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0"; // or your MongoDB Atlas connection string
  const client = new MongoClient(uri);

  try {
    await client.connect();
    console.log("edunova_x database connected");
  } catch (error) {
    console.error("❌ MongoDB connection error:", error);
  } finally {
    await client.close();
  }
}

main().catch(console.error);
