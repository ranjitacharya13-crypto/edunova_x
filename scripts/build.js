const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const rootDir = path.resolve(__dirname, '..');
const frontendDir = path.join(rootDir, 'frontend');
const frontendDist = path.join(frontendDir, 'dist');
const rootDist = path.join(rootDir, 'dist');

console.log('🚀 [EduNova X Build] Starting production build...');

// Step 0: Validate Cloudflare Workers/Assets configs.
// Edunova_X is a static React/Vite SPA for Cloudflare Assets. Assets-only
// deployments must NOT define an assets binding. A binding is only valid when
// a real Worker `main` entry point exists and uses env.ASSETS.
let deploysWithWorkerMain = false;
function inspectWranglerConfig(configFile) {
  const raw = fs.readFileSync(configFile, 'utf8');
  const hasAssetsBinding =
    /^\s*binding\s*=\s*["'][^"']+["']/m.test(raw) || /"binding"\s*:\s*"[^"]+"/.test(raw);
  const hasMain = /^\s*main\s*=\s*"/m.test(raw) || /"main"\s*:\s*"/.test(raw);

  if (hasAssetsBinding && !hasMain) {
    return { ok: false, mode: 'invalid-assets-binding' };
  }

  if (hasMain) deploysWithWorkerMain = true;
  return { ok: true, mode: hasMain ? 'worker-with-assets' : 'assets-only' };
}

['wrangler.toml', 'wrangler.jsonc', 'wrangler.json']
  .map((file) => path.join(rootDir, file))
  .filter(fs.existsSync)
  .forEach((configFile) => {
    const result = inspectWranglerConfig(configFile);
    if (!result.ok) {
      console.error(`❌ [EduNova X Build] ${path.basename(configFile)}: assets defines a binding but no "main" worker script.`);
      console.error('   Cloudflare rejects this with: "Cannot use assets with a binding in an assets-only Worker."');
      console.error(`   Fix: remove the assets binding for assets-only deployments, or add a real Worker main.`);
      process.exit(1);
    }
    console.log(`✅ [EduNova X Build] ${path.basename(configFile)}: ${result.mode} config OK`);
  });

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

  // Ensure static deployment metadata exists in root dist. Do not ship a Worker
  // entry point for assets-only deployments; Wrangler will serve ./dist directly.
  const publicDir = path.join(frontendDir, 'public');
  ['manifest.json', 'edu-assistance-snn.svg', '_redirects', '_headers', '_routes.json', '.assetsignore'].forEach(file => {
    const src = path.join(publicDir, file);
    const dest = path.join(rootDist, file);
    if (fs.existsSync(src) && !fs.existsSync(dest)) {
      fs.copyFileSync(src, dest);
    }
  });

  if (!deploysWithWorkerMain) {
    // These files are meaningful for Pages/Workers-with-a-script, but are not
    // needed for Cloudflare Workers assets-only. SPA fallback is configured via
    // assets.not_found_handling above, so avoid uploading a Pages-style redirect
    // that Wrangler warns is an infinite loop.
    ['_worker.js', '_redirects'].forEach((file) => {
      fs.rmSync(path.join(rootDist, file), { force: true });
    });
  }

  console.log('✅ [EduNova X Build] Build complete! Static assets ready in ./dist and ./frontend/dist');
} else {
  console.error('❌ [EduNova X Build] Error: frontend/dist was not generated.');
  process.exit(1);
}
