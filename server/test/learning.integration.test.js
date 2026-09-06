// Real MongoDB integration. Only a disposable *_test database may be used.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const uri = process.env.MONGO_TEST_URI;
const enabled = !!uri;
if (uri && !/\/edunova_test(?:\?|$)/.test(uri)) throw new Error('Integration tests require an isolated edunova_test database');
const User = require('../models/User');
const Timetable = require('../models/Timetable');
const Assignment = require('../models/Assignment');
const QuizAttempt = require('../models/QuizAttempt');
const StudyPlan = require('../models/StudyPlan');
const ARLesson = require('../models/ARLesson');
const { executeApplicationTool, confirmApplicationTool: confirmToolAction } = require('../services/applicationTools');
const executeTool = (name, owner, args) => executeApplicationTool(name, args, owner, 'integration');
const { createPracticeQuiz, findQuiz, publicQuiz, submitQuiz, performanceSummary } = require('../services/quizService');
const { learningDocuments } = require('../services/learningMaterials');
const { seedCurriculum, educationalContext } = require('../services/arLessons');
let alice, bob;
before(async () => {
  if (!enabled) return;
  await mongoose.connect(uri);
  await mongoose.connection.dropDatabase();
  [alice, bob] = await User.create([
    { name: 'Integration Alice', username: 'int-alice', email: 'alice@example.invalid', password: 'fixture-hash-not-a-live-password', role: 'student', enrolledClasses: ['physics-a'] },
    { name: 'Integration Bob', username: 'int-bob', email: 'bob@example.invalid', password: 'fixture-hash-not-a-live-password', role: 'student', enrolledClasses: ['math-b'] },
  ]);
});
after(async () => { if (enabled) { await mongoose.connection.dropDatabase(); await mongoose.disconnect(); } });
const quizInput = { title: 'Optics', subject: 'Physics', topic: 'Lens', questions: [{ question: 'What does a convex lens do to parallel rays?', options: ['Converges them', 'Always diverges them'], answerIndex: 0 }] };

test('Mongo: private quiz persistence, answer hiding, scoring and weakest-subject derivation', { skip: !enabled }, async () => {
  const saved = await createPracticeQuiz(alice, quizInput);
  const quiz = await findQuiz(alice, saved.quizId);
  assert.equal(quiz.kind, 'practice'); assert.equal(quiz.fileId, null);
  assert.equal(publicQuiz(quiz).questions[0].answerIndex, undefined);
  await assert.rejects(findQuiz(bob, saved.quizId), /not found/);
  const attempt = await submitQuiz(alice, saved.quizId, [1]);
  assert.equal(attempt.score, 0);
  assert.equal(await QuizAttempt.countDocuments({ userId: alice._id }), 1);
  assert.equal((await performanceSummary(alice))[0].averageScore, 0);
  assert.deepEqual(await performanceSummary(bob), []);
});

test('Mongo: confirmation is owner-bound and replay cannot duplicate a saved plan', { skip: !enabled }, async () => {
  const pending = await executeTool('create_study_plan', String(alice._id), { title: 'Revision', subject: 'Physics', schedule: [{ day: 'Monday', time: '17:00', subject: 'Physics', topic: 'Lens', task: 'Review course notes' }] });
  assert.equal(pending.data.requiresConfirmation, true);
  assert.equal(await StudyPlan.countDocuments({ userId: alice._id }), 0);
  const denied = await confirmToolAction(pending.data.confirmationToken, String(bob._id));
  assert.equal(denied.success, false);
  const saved = await confirmToolAction(pending.data.confirmationToken, String(alice._id));
  assert.equal(saved.success, true);
  assert.equal(saved.data.navigate.view, 'progress');
  const replay = await confirmToolAction(pending.data.confirmationToken, String(alice._id));
  assert.equal(replay.success, false);
  assert.equal(await StudyPlan.countDocuments({ userId: alice._id }), 1);
});

test('Mongo: timetable prefers owner then enrolled class, never another student', { skip: !enabled }, async () => {
  await Timetable.create([
    { Monday: [{ period: 1, subject: 'Shared lesson' }] },
    { classId: 'physics-a', Monday: [{ period: 1, subject: 'Physics' }] },
    { ownerId: bob._id, Monday: [{ period: 1, subject: 'Private math' }] },
  ]);
  let result = await executeTool('get_timetable', String(alice._id), { day: 'Monday' });
  assert.equal(result.data.schedule.Monday[0].subject, 'Physics');
  await Timetable.create({ ownerId: alice._id, Monday: [{ period: 1, subject: 'Optics' }] });
  result = await executeTool('get_timetable', String(alice._id), { day: 'Monday' });
  assert.equal(result.data.schedule.Monday[0].subject, 'Optics');
  assert.equal(result.data.scope, 'user');
});

test('Mongo/GridFS: real text upload is extracted; export excludes another owner', { skip: !enabled }, async () => {
  const { GridFSBucket } = require('mongodb');
  const bucket = new GridFSBucket(mongoose.connection.db, { bucketName: 'study_files' });
  for (const [owner, text] of [[alice, 'The retina converts light into neural signals.'], [bob, 'PRIVATE BOB NOTE MUST NEVER LEAK']]) {
    await new Promise((resolve, reject) => { const stream = bucket.openUploadStream('Optics.txt', { contentType: 'text/plain', metadata: { ownerId: String(owner._id), visibility: 'private' } }); stream.on('finish', resolve); stream.on('error', reject); stream.end(Buffer.from(text)); });
  }
  const corpus = await learningDocuments(alice);
  assert(corpus.documents.some((d) => d.text.includes('neural signals')));
  assert(!JSON.stringify(corpus).includes('PRIVATE BOB'));
});

test('Mongo: published curriculum seed is idempotent and selected hotspot is canonical', { skip: !enabled }, async () => {
  await seedCurriculum(); await seedCurriculum();
  assert.equal(await ARLesson.countDocuments({ slug: 'human-eye' }), 1);
  const lesson = await ARLesson.findOne({ slug: 'human-eye' });
  const context = await educationalContext(alice, { lessonId: String(lesson._id), hotspotId: 'retina' });
  assert.equal(context.subject, 'Physics');
  assert.equal(context.selectedPart, 'Retina');
  await assert.rejects(educationalContext(alice, { lessonId: String(lesson._id), hotspotId: 'unknown' }), /Hotspot/);
});

test('Mongo: forged identity arguments and forged scores never become writes', { skip: !enabled }, async () => {
  const forged = await executeTool('get_progress', String(alice._id), { userId: String(bob._id) });
  assert.equal(forged.success, false);
  const score = await executeTool('update_progress', String(alice._id), { subject: 'Physics', progressPercent: 100 });
  assert.equal(score.success, false);
  alice.isBlocked = true; await alice.save();
  assert.equal((await executeTool('get_progress', String(alice._id), {})).success, false);
  alice.isBlocked = false; await alice.save();
});
