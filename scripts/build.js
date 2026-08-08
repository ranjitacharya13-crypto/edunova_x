const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const rootDir = path.resolve(__dirname, '..');
const frontendDir = path.join(rootDir, 'frontend');
const frontendDist = path.join(frontendDir, 'dist');
const rootDist = path.join(rootDir, 'dist');

console.log('🚀 [EduNova X Build] Starting production build...');

// Set environment variables to prevent electron binary download during CI/web builds
process.env.ELECTRON_SKIP_BINARY_DOWNLOAD = '1';

// Step 1: Install frontend dependencies if needed
const frontendNodeModules = path.join(frontendDir, 'node_modules');
if (!fs.existsSync(frontendNodeModules)) {
  console.log('📦 [EduNova X Build] Installing frontend dependencies...');
  execSync('npm install --no-audit --no-fund', {
    cwd: frontendDir,
    stdio: 'inherit',
    env: { ...process.env, ELECTRON_SKIP_BINARY_DOWNLOAD: '1' }
  });
}

// Step 2: Build frontend with Vite
console.log('⚡ [EduNova X Build] Building Vite frontend...');
execSync('npm run build', {
  cwd: frontendDir,
  stdio: 'inherit',
  env: { ...process.env, ELECTRON_SKIP_BINARY_DOWNLOAD: '1' }
});

// Step 3: Mirror frontend/dist to root dist/ for Cloudflare / universal CI output
if (fs.existsSync(frontendDist)) {
  console.log('📁 [EduNova X Build] Copying dist output to root dist/...');
  fs.rmSync(rootDist, { recursive: true, force: true });
  fs.cpSync(frontendDist, rootDist, { recursive: true });

  // Ensure _redirects, _headers, and _routes.json exist in root dist
  const publicDir = path.join(frontendDir, 'public');
  ['manifest.json', 'edu-assistance-snn.svg', '_redirects', '_headers', '_routes.json', '_worker.js'].forEach(file => {
    const src = path.join(publicDir, file);
    const dest = path.join(rootDist, file);
    if (fs.existsSync(src) && !fs.existsSync(dest)) {
      fs.copyFileSync(src, dest);
    }
  });

  console.log('✅ [EduNova X Build] Build complete! Static assets ready in ./dist and ./frontend/dist');
} else {
  console.error('❌ [EduNova X Build] Error: frontend/dist was not generated.');
  process.exit(1);
}
