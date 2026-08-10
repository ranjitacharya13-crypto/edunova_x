const { MongoClient } = require('mongodb');
const path = require('path');

async function main() {
  const uri = process.env.MONGO_URI;
  if (!uri) {
    console.error('Please set MONGO_URI environment variable with your connection string.');
    process.exit(1);
  }

  const client = new MongoClient(uri, { useNewUrlParser: true, useUnifiedTopology: true });
  try {
    await client.connect();
    const db = client.db('edunova');
    const col = db.collection('teacher_timetables');

    const filePath = path.join(__dirname, '..', 'student_timetable_with_times.json');
    const doc = require(filePath);

    const res = await col.insertOne(doc);
    console.log('Inserted document with _id:', res.insertedId);
  } catch (err) {
    console.error('Insert failed:', err);
  } finally {
    await client.close();
  }
}

main();
