const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const rootDir = path.resolve(__dirname, '..');
const frontendDir = path.join(rootDir, 'frontend');
const frontendDist = path.join(frontendDir, 'dist');
const rootDist = path.join(rootDir, 'dist');

console.log('🚀 [EduNova X Build] Starting production build...');

// Step 0: Validate Cloudflare Worker configs.
// Prevents the "Cannot use assets with a binding in an assets-only Worker" deploy error:
// an [assets] binding (e.g. binding = "ASSETS") requires a "main" worker script.
function validateWranglerConfig(configFile) {
  if (!fs.existsSync(configFile)) return true;
  const raw = fs.readFileSync(configFile, 'utf8');
  const hasAssetsBinding =
    /^\s*binding\s*=\s*["']ASSETS["']/m.test(raw) || /"binding"\s*:\s*"ASSETS"/.test(raw);
  if (!hasAssetsBinding) return true;
  const hasMain = /^\s*main\s*=\s*"/m.test(raw) || /"main"\s*:\s*"/.test(raw);
  return hasMain;
}

['wrangler.toml', 'wrangler.jsonc', 'wrangler.json']
  .map((file) => path.join(rootDir, file))
  .filter(fs.existsSync)
  .forEach((configFile) => {
    if (!validateWranglerConfig(configFile)) {
      console.error(`❌ [EduNova X Build] ${path.basename(configFile)}: [assets] defines a binding but no "main" worker script.`);
      console.error('   Cloudflare rejects this with: "Cannot use assets with a binding in an assets-only Worker."');
      console.error(`   Fix: add main = "./dist/_worker.js" to ${path.basename(configFile)} (or remove the asset binding).`);
      process.exit(1);
    }
    console.log(`✅ [EduNova X Build] ${path.basename(configFile)}: assets binding + main worker script OK`);
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

  // Ensure _redirects, _headers, and _routes.json exist in root dist
  const publicDir = path.join(frontendDir, 'public');
  ['manifest.json', 'edu-assistance-snn.svg', '_redirects', '_headers', '_routes.json', '_worker.js', '.assetsignore'].forEach(file => {
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
