const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { execFileSync } = require('child_process');

function command(name, args, cwd, log) {
  return new Promise((resolve, reject) => {
    log(`\n$ ${name} ${args.join(' ')}\n`);
    const child = spawn(name, args, { cwd, shell: process.platform === 'win32', env: process.env });
    child.stdout.on('data', d => log(d.toString()));
    child.stderr.on('data', d => log(d.toString()));
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve() : reject(new Error(`${name} exited with code ${code}`)));
  });
}
function copyTree(source, target) {
  fs.mkdirSync(target, { recursive: true });
  for (const item of fs.readdirSync(source, { withFileTypes: true })) {
    if (['node_modules', 'dist', '.env', '.git'].includes(item.name)) continue;
    const from = path.join(source, item.name), to = path.join(target, item.name);
    item.isDirectory() ? copyTree(from, to) : fs.copyFileSync(from, to);
  }
}
function nodeVersion() { return process.version.replace(/^v/, '').split('.').map(Number); }
async function bootstrap({ sourceRoot, targetRoot, log }) {
  log('EduNova X installation bootstrap\n===============================\n');
  const [major] = nodeVersion();
  if (major < 20) throw new Error(`Node.js v20+ is required (found ${process.version}). Install Node.js and run setup again.`);
  log(`✓ Node.js ${process.version}\n`);
  try { log(`✓ npm ${execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['--version'], { encoding: 'utf8' }).trim()}\n`); }
  catch { throw new Error('npm was not found on PATH. Install Node.js v20+ (which includes npm).'); }
  log(`Preparing application files (${targetRoot})...\n`);
  copyTree(sourceRoot, targetRoot);
  for (const folder of ['server', 'frontend', 'signaling', 'ai_engine']) {
    const cwd = path.join(targetRoot, folder);
    if (fs.existsSync(path.join(cwd, 'package.json'))) {
      log(`\n[${folder}] Installing npm dependencies...\n`);
      await command(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install', '--no-audit', '--no-fund'], cwd, log);
    } else log(`\n[${folder}] No package.json found; skipping npm install (Python AI engine).\n`);
  }
  log('\n[frontend] Building React production bundle...\n');
  await command(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build'], path.join(targetRoot, 'frontend'), log);
  log('\n✓ Native modules (sharp/pdf-thumbnail) were installed for this host by npm.\n');
  if (process.platform === 'win32') log('  If a native build fails, install Visual Studio Build Tools with “Desktop development with C++”, then retry.\n');
  if (process.platform === 'darwin') log('  If a native build fails, install Xcode Command Line Tools, then retry.\n');
  log(`\n✓ Installation complete (${scopeLabel(scope)}).\n`);
}
function scopeLabel(scope) { return scope === 'all' ? 'all users' : 'just me'; }
module.exports = { bootstrap };
