const { MongoClient, ObjectId } = require('mongodb');
const path = require('path');

async function main() {
  const uri = process.env.MONGO_URI;
  if (!uri) {
    console.error('Please set MONGO_URI environment variable with your connection string.');
    process.exit(1);
  }

  const client = new MongoClient(uri);
  try {
    await client.connect();
    const db = client.db('edunova');
    const col = db.collection('teacher_timetables');

    const filePath = path.join(__dirname, '..', 'student_timetable_with_times.json');
    const doc = require(filePath);

    if (doc._id && doc._id.$oid) {
      doc._id = new ObjectId(doc._id.$oid);
    }

    // Replace if exists or insert
    const res = await col.replaceOne({ _id: doc._id }, doc, { upsert: true });
    console.log('Successfully upserted timetable document with _id:', doc._id.toString());
  } catch (err) {
    console.error('Insert failed:', err);
  } finally {
    await client.close();
  }
}

main();
