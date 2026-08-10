const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { bootstrap } = require('./bootstrap');

let window;
let serverProcess;
const runtimeRoot = () => path.join(app.getPath('userData'), 'runtime');
const envFile = () => path.join(runtimeRoot(), 'server', '.env');

function createWindow() {
  window = new BrowserWindow({
    width: 940, height: 680, minWidth: 720, minHeight: 520,
    title: 'EduNova X Setup',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false }
  });
  window.loadFile(path.join(__dirname, 'setup.html'));
}
function send(channel, value) { if (window && !window.isDestroyed()) window.webContents.send(channel, value); }
function runServer() {
  if (serverProcess && !serverProcess.killed) return;
  const root = runtimeRoot();
  serverProcess = spawn(process.execPath, [path.join(root, 'server', 'server.js')], {
    cwd: path.join(root, 'server'), env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', PORT: '4000' }, windowsHide: true
  });
  serverProcess.stdout.on('data', data => send('log', data.toString()));
  serverProcess.stderr.on('data', data => send('log', data.toString()));
  serverProcess.on('error', err => send('log', `Launcher Service error: ${err.message}\n`));
  serverProcess.on('exit', code => send('log', `Launcher Service stopped (code ${code}).\n`));
}
async function openApp() {
  runServer();
  await new Promise(resolve => setTimeout(resolve, 1200));
  await shell.openExternal('http://localhost:4000');
}
ipcMain.handle('save-config', async (_event, values) => {
  fs.mkdirSync(path.dirname(envFile()), { recursive: true });
  const existing = fs.existsSync(envFile()) ? fs.readFileSync(envFile(), 'utf8') : '';
  const lines = existing.split(/\r?\n/).filter(line => !/^(MONGO_URI|TURN_URL|TURN_USERNAME|TURN_CREDENTIAL)=/.test(line));
  lines.push(`MONGO_URI=${values.mongoUri}`, `TURN_URL=${values.turnUrl || ''}`, `TURN_USERNAME=${values.turnUsername || ''}`, `TURN_CREDENTIAL=${values.turnCredential || ''}`, 'PORT=4000');
  fs.writeFileSync(envFile(), `${lines.filter(Boolean).join('\n')}\n`, { mode: 0o600 });
  // Vite embeds VITE_* values at build time, so rebuild once after the first-launch form.
  const frontendEnv = path.join(runtimeRoot(), 'frontend', '.env');
  fs.writeFileSync(frontendEnv, `VITE_TURN_URL=${values.turnUrl || ''}\nVITE_TURN_USERNAME=${values.turnUsername || ''}\nVITE_TURN_CREDENTIAL=${values.turnCredential || ''}\n`, { mode: 0o600 });
  await new Promise((resolve, reject) => {
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const child = spawn(npm, ['run', 'build'], { cwd: path.join(runtimeRoot(), 'frontend'), windowsHide: true });
    child.stdout.on('data', data => send('log', data.toString()));
    child.stderr.on('data', data => send('log', data.toString()));
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve() : reject(new Error(`frontend build exited with code ${code}`)));
  });
  return true;
});
ipcMain.handle('install', async (_event, scope) => {
  try { await bootstrap({ sourceRoot: app.getAppPath(), targetRoot: runtimeRoot(), scope, log: message => send('log', message) }); return { ok: true }; }
  catch (error) { send('log', `\nERROR: ${error.message}\n`); return { ok: false, error: error.message }; }
});
ipcMain.handle('launch', openApp);
ipcMain.handle('has-config', () => fs.existsSync(envFile()));
app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (serverProcess) serverProcess.kill(); if (process.platform !== 'darwin') app.quit(); });
