// Browser contracts use explicit fixtures. These are NOT deployed intelligence
// or physical 2GB-phone/WebXR-camera acceptance tests.
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
const lesson = { ...JSON.parse(fs.readFileSync(new URL('../../server/catalog/ar-lessons.json', import.meta.url), 'utf8'))[0], _id: '64d000000000000000000001' };
const quizId = '64d000000000000000000002';
async function signedIn(page, lowMemory = true) {
  await page.addInitScript((low) => {
    if (low) Object.defineProperty(navigator, 'deviceMemory', { get: () => 2 });
    window.__cameraCalls = 0;
    if (navigator.mediaDevices) navigator.mediaDevices.getUserMedia = async () => { window.__cameraCalls++; throw new Error('Camera must not be requested automatically'); };
  }, lowMemory);
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url()), path = url.pathname;
    if (!path.startsWith("/api/")) return route.continue();
    const json = (body, status = 200) => route.fulfill({ status, json: body });
    if (path === '/api/auth/login') return json({ token: 'explicit-browser-test-token', user: { id: '64d000000000000000000010', role: 'student', name: 'Browser Learner' } });
    if (path === '/api/ai/health') return json({ modelReady: true, readyForTraffic: true, status: 'ready' });
    if (path === '/api/ar/lessons') return json({ lessons: [lesson] });
    if (path.startsWith('/api/ar/lessons/')) return json({ lesson });
    if (path === `/api/quizzes/${quizId}`) return json({ quiz: { id: quizId, title: 'Eye practice', questions: [{ question: 'Where are photoreceptors?', options: ['Retina', 'Lens'] }] } });
    if (path === `/api/quizzes/${quizId}/attempts`) return json({ score: 100, correctAnswers: 1, totalQuestions: 1, answers: [{ question: 'Where are photoreceptors?', selectedOption: 'Retina', correctOption: 'Retina', isCorrect: true }] });
    if (path === '/api/quizzes/progress') return json({ subjects: [{ _id: 'Physics', averageScore: 100, attempts: 1 }], studyPlans: [], studyHistory: [] });
    if (path === '/api/timetable/today') return json({ day: 'Monday', periods: [], hasTimetable: false });
    if (path === '/api/timetable') return json({});
    if (path === '/api/study' || path === '/api/syllabus') return json([]);
    return json({});
  });
  await page.goto('/');
  await page.getByPlaceholder(/^email$/i).fill('learner@example.invalid');
  await page.getByPlaceholder(/password/i).fill('browser-fixture-only');
  await page.getByRole('button', { name: /^sign in$|^login$/i }).click();
  await expect(page.getByText('Browser Learner').first()).toBeVisible();
}
async function openLesson(page) {
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('edunova:navigate', { detail: { view: 'study' } })));
  await page.getByRole('button', { name: /View in AR/ }).click();
  await expect(page.getByRole('heading', { name: lesson.title })).toBeVisible();
}

test('low-memory reading mode is useful, camera-free, and sends only canonical context IDs to AI', async ({ page }) => {
  const requests = [];
  page.on('request', (request) => requests.push(request.url()));
  await signedIn(page); await page.setViewportSize({ width: 390, height: 844 }); await openLesson(page);
  await expect(page.getByRole('button', { name: /Load optional 3D/ })).toBeVisible();
  expect(requests.some((url) => url.endsWith('.glb'))).toBe(false);
  await page.getByRole('button', { name: 'Retina', exact: true }).click();
  await expect(page.getByText(/Light-sensitive tissue at the back/)).toBeVisible();
  await page.getByRole('button', { name: 'Ask AI about Retina', exact: true }).click();
  let received;
  await page.route('**/api/ai/chat', async (route) => {
    received = route.request().postDataJSON();
    return route.fulfill({ contentType: 'text/event-stream', body: 'data: {"type":"token","delta":"Retina explanation"}\n\ndata: {"type":"answer","success":true,"message":"Retina explanation","conversationId":"browser-conversation-123456","actions":[],"sources":[]}\n\n' });
  });
  await page.getByRole('button', { name: /^Ask EduNova AI$/ }).click();
  await expect(page.getByText('Retina explanation', { exact: true })).toBeVisible();
  expect(received.applicationContext.context).toEqual({ lessonId: lesson._id, hotspotId: 'retina' });
  expect(JSON.stringify(received)).not.toContain('base64');
  expect(await page.evaluate(() => window.__cameraCalls)).toBe(0);
});

test('lazy 3D loads the real original GLB and disposes on exit', async ({ page }) => {
  await signedIn(page); await openLesson(page);
  await page.getByRole('button', { name: /Load optional 3D/ }).click();
  await expect(page.locator('model-viewer')).toHaveCount(1);
  await expect.poll(() => page.locator('model-viewer').evaluate((viewer) => viewer.loaded), { timeout: 25000 }).toBe(true);
  expect(await page.evaluate(() => window.__cameraCalls)).toBe(0);
  await page.getByRole('button', { name: /Exit AR/ }).click();
  await expect(page.locator('model-viewer')).toHaveCount(0);
});

test('asset failure retains illustrated lesson and hotspots', async ({ page }) => {
  await signedIn(page); await page.route('**/*.glb', (route) => route.abort()); await openLesson(page);
  await page.getByRole('button', { name: /Load optional 3D/ }).click();
  await expect(page.getByRole('alert')).toContainText(/could not render|could not be loaded/);
  await expect(page.getByAltText(/illustrated teaching schematic/)).toBeVisible();
  await page.getByRole('button', { name: 'Lens', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Lens', exact: true })).toBeVisible();
});

test('AI quiz confirmation stays pending until save and opens a usable quiz/progress view', async ({ page }) => {
  await signedIn(page); await openLesson(page);
  await page.getByRole('button', { name: 'Practice Quiz', exact: true }).last().click();
  await page.route('**/api/ai/chat', (route) => route.fulfill({ contentType: 'text/event-stream', body: `data: ${JSON.stringify({ type: 'answer', success: true, message: 'Review this proposed quiz.', conversationId: 'browser-conversation-123456', actions: [{ tool: 'save_quiz', message: 'Confirm quiz', data: { requiresConfirmation: true, confirmationToken: 'fixture-confirmation' } }] })}\n\n` }));
  let saves = 0;
  await page.route('**/api/ai/actions/*/confirm', (route) => { saves++; return route.fulfill({ json: { success: true, data: { message: 'Open Eye practice', navigate: { view: 'quiz', id: quizId } } } }); });
  await page.getByRole('button', { name: /^Ask EduNova AI$/ }).click();
  await expect(page.getByRole('button', { name: 'Confirm and save' })).toBeVisible();
  expect(saves).toBe(0);
  await page.getByRole('button', { name: 'Confirm and save' }).click();
  await page.getByRole('button', { name: /Open Eye practice/ }).click();
  expect(saves).toBe(1);
  await expect(page.getByRole('heading', { name: 'Eye practice' })).toBeVisible();
  await page.getByRole('radio', { name: 'Retina', exact: true }).check();
  await page.getByRole('button', { name: 'Submit quiz' }).click();
  await expect(page.getByText('100% · 1/1 correct')).toBeVisible();
  await page.getByRole('button', { name: /View my progress/ }).click();
  await expect(page.getByRole('heading', { name: 'Your learning progress' })).toBeVisible();
  await expect(page.getByText('Average across 1 saved attempts')).toBeVisible();
});

test('failed readiness is not presented as ready and arbitrary navigation is ignored', async ({ page }) => {
  await signedIn(page);
  await page.route('**/api/ai/health', (route) => route.fulfill({ status: 503, json: { modelReady: false, status: 'ready', permanentFailure: true, errorStage: 'OUT_OF_MEMORY' } }));
  const status = await page.evaluate(async () => { const { classifyAIHealth } = await import('/src/api/api.js'); return classifyAIHealth({ modelReady: false, status: 'ready', permanentFailure: true }, 503); });
  expect(status).toBe('unavailable');
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('edunova:navigate', { detail: { view: 'javascript:alert(1)' } })));
  await expect(page.getByRole('heading', { name: lesson.title })).toHaveCount(0);
});
