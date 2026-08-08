<#
 =============================================================================
 EduNova_X - LOCAL PRODUCTION SMOKE TEST (PHASE 13) - PowerShell
 -----------------------------------------------------------------------------
 Fail-closed verification of all three backend services + frontend build.
 Any failing check exits with a non-zero code. Nothing is "hidden" - every
 check prints [OK]/[FAIL] and failures are summarized at the end.

 Checks:
   1. Node.js >= 20
   2. Required env vars PRESENT (values NEVER printed)
   3. Frontend production build (vite build) - optional, -Build
   4. API server  : GET /health, /api/test, /
   5. Signaling   : GET /health, /, and Socket.IO Engine.IO handshake
   6. AI engine   : GET /health

 Usage:
   .\scripts\verify-production.ps1                 # defaults: API 4000, SIG 5000, AI 8001
   .\scripts\verify-production.ps1 -Build          # also run the frontend build
   .\scripts\verify-production.ps1 -SkipAI         # consciously skip the AI check
   $env:API_PORT=4100; .\scripts\verify-production.ps1
 =============================================================================
#>
[CmdletBinding()]
param(
  [switch]$Build,
  [switch]$SkipAI
)
$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot  = Resolve-Path (Join-Path $scriptDir "..")
$apiPort   = if ($env:API_PORT)   { [int]$env:API_PORT }   else { 4000 }
$sigPort   = if ($env:SIGNAL_PORT) { [int]$env:SIGNAL_PORT } else { 5000 }
$aiPort    = if ($env:AI_PORT)    { [int]$env:AI_PORT }    else { 8001 }

$pass = 0; $fail = 0
function Write-Ok   { $script:pass++; Write-Host "[ OK ]" -ForegroundColor Green  -NoNewline; Write-Host " $args" }
function Write-Bad  { $script:fail++; Write-Host "[FAIL]" -ForegroundColor Red    -NoNewline; Write-Host " $args" }
function Write-Warn { Write-Host "[WARN]" -ForegroundColor Yellow -NoNewline; Write-Host " $args" }

$started = @()
function Stop-TestServices {
  foreach ($p in $started) { try { Stop-Process -Id $p -Force -ErrorAction SilentlyContinue } catch {} }
}

Write-Host "============================================================"
Write-Host " EduNova_X - LOCAL PRODUCTION SMOKE TEST"
Write-Host "============================================================"

# --- 1. Node version ----------------------------------------------------------
Write-Host "`n>> 1. Node.js version check"
try {
  $nodeVer = & node -v 2>$null
  $major = [int]($nodeVer -replace 'v([0-9]+).*', '$1')
  if ($major -ge 20) { Write-Ok "Node $nodeVer (>= 20)" } else { Write-Bad "Node $nodeVer < 20 - deployment target requires Node 20+" }
} catch { Write-Bad "node not found on PATH"; exit 1 }

# --- 2. Env var presence (values masked) --------------------------------------
Write-Host "`n>> 2. Required env vars (PRESENT/MISSING only - values never shown)"
$serverEnv = Join-Path $repoRoot "server\.env"
$frontEnv  = Join-Path $repoRoot "frontend\.env"
if (Test-Path $serverEnv) {
  Get-Content $serverEnv | Where-Object { $_ -match '^\s*[A-Za-z_][A-Za-z0-9_]*=' } | ForEach-Object {
    $k = ($_ -split '=', 2)[0].Trim()
    if ($k -in @("PORT","AI_ENGINE_URL")) { return }
    $v = ($_ -split '=', 2)[1].Trim()
    if ($v) { Write-Ok "server/.env $k = PRESENT" } else { Write-Warn "server/.env $k = MISSING (empty)" }
  }
} else { Write-Bad "server/.env not found (needed for MONGO_URI / JWT_SECRET locally)" }

if (Test-Path $frontEnv) {
  Get-Content $frontEnv | Where-Object { $_ -match '^\s*[A-Za-z_][A-Za-z0-9_]*=' } | ForEach-Object {
    $k = ($_ -split '=', 2)[0].Trim(); $v = ($_ -split '=', 2)[1].Trim()
    if ($v) { Write-Ok "frontend/.env $k = PRESENT" } else { Write-Warn "frontend/.env $k = MISSING (empty)" }
  }
} else { Write-Warn "frontend/.env not found (dev defaults apply)" }

# --- 3. Frontend build (optional) ---------------------------------------------
if ($Build) {
  Write-Host "`n>> 3. Frontend production build"
  if (-not (Test-Path (Join-Path $repoRoot "frontend\node_modules"))) {
    Write-Bad "frontend/node_modules missing - run: cd frontend; npm install"
  } else {
    Push-Location (Join-Path $repoRoot "frontend")
    & npm run build 2>&1 | Out-Null
    if ($LASTEXITCODE -eq 0) { Write-Ok "vite build succeeded (dist/)" } else { Write-Bad "vite build FAILED (see output above)" }
    Pop-Location
  }
}

# --- 4. Start services --------------------------------------------------------
Write-Host "`n>> Starting services on ports $apiPort (API), $sigPort (signaling), $aiPort (AI)"
foreach ($p in @($apiPort, $sigPort, $aiPort)) {
  $t = Test-NetConnection -ComputerName 127.0.0.1 -Port $p -WarningAction SilentlyContinue -InformationLevel Quiet
  if ($t) { Write-Bad "port $p already in use - stop the existing process or override *_PORT env" }
}
if ($fail -gt 0) { Write-Host "`nBLOCKED - fix the failures above."; exit 1 }

if (-not (Test-Path (Join-Path $repoRoot "server\node_modules")))      { Write-Bad "server/node_modules missing - run: cd server; npm install" }
else {
  $env:PORT = "$apiPort"
  $p = Start-Process -FilePath "node" -ArgumentList "server.js" -WorkingDirectory (Join-Path $repoRoot "server") -PassThru -RedirectStandardOutput (Join-Path $env:TEMP "edunova-api.log") -RedirectStandardError (Join-Path $env:TEMP "edunova-api-err.log") -WindowStyle Hidden
  Remove-Item Env:\PORT -ErrorAction SilentlyContinue
  $started += $p.Id
}
if (-not (Test-Path (Join-Path $repoRoot "signaling\node_modules")))  { Write-Bad "signaling/node_modules missing - run: cd signaling; npm install" }
else {
  $env:PORT = "$sigPort"
  $p = Start-Process -FilePath "node" -ArgumentList "index.js" -WorkingDirectory (Join-Path $repoRoot "signaling") -PassThru -RedirectStandardOutput (Join-Path $env:TEMP "edunova-signal.log") -RedirectStandardError (Join-Path $env:TEMP "edunova-signal-err.log") -WindowStyle Hidden
  Remove-Item Env:\PORT -ErrorAction SilentlyContinue
  $started += $p.Id
}
if ($SkipAI) { Write-Warn "AI engine check SKIPPED (-SkipAI)" }
elseif (-not (Get-Command uvicorn -ErrorAction SilentlyContinue) -and -not (Get-Command python3 -ErrorAction SilentlyContinue)) {
  Write-Bad "AI engine prereqs missing - neither uvicorn nor python3 found (pip install -r ai_engine\requirements.txt)"
} else {
  $aiCmd = if (Get-Command uvicorn -ErrorAction SilentlyContinue) { "uvicorn" } else { "python3" }
  $aiArgs = if ($aiCmd -eq "uvicorn") { @("main:app","--host","127.0.0.1","--port","$aiPort") } else { @("-m","uvicorn","main:app","--host","127.0.0.1","--port","$aiPort") }
  $p = Start-Process -FilePath $aiCmd -ArgumentList $aiArgs -WorkingDirectory (Join-Path $repoRoot "ai_engine") -PassThru -RedirectStandardOutput (Join-Path $env:TEMP "edunova-ai.log") -RedirectStandardError (Join-Path $env:TEMP "edunova-ai-err.log") -WindowStyle Hidden
  $started += $p.Id
}

# Wait for ports (max 30s each)
function Wait-Port([int]$port, [string]$label) {
  for ($i = 0; $i -lt 30; $i++) {
    $t = Test-NetConnection -ComputerName 127.0.0.1 -Port $port -WarningAction SilentlyContinue -InformationLevel Quiet
    if ($t) { return $true }
    Start-Sleep -Seconds 1
  }
  Write-Bad "$label did not start on port $port within 30s - see $env:TEMP\edunova-*.log"
  return $false
}
$apiUp = Wait-Port $apiPort "API server"
$sigUp = Wait-Port $sigPort "signaling server"
$aiUp  = if ($SkipAI) { $true } else { Wait-Port $aiPort "AI engine" }

# --- 5. HTTP checks -----------------------------------------------------------
Write-Host "`n>> 5. HTTP checks (expect 200)"
function Test-Endpoint([string]$label, [string]$url, [string]$bodyMatch = "") {
  try {
    $r = Invoke-WebRequest -Uri $url -TimeoutSec 10 -UseBasicParsing -Headers @{ Origin = "https://edunova-x.vercel.app" }
    if ($bodyMatch -and $r.Content -notmatch $bodyMatch) { Write-Bad "$label - HTTP $($r.StatusCode) but body missing '$bodyMatch'" }
    else { Write-Ok "$label - HTTP $($r.StatusCode)" }
  } catch { Write-Bad "$label - $($_.Exception.Message)" }
}
if ($apiUp) {
  Test-Endpoint "API  GET /health"   "http://127.0.0.1:$apiPort/health"   "edunova-x-production"
  Test-Endpoint "API  GET /api/test" "http://127.0.0.1:$apiPort/api/test"
  Test-Endpoint "API  GET / (root)"  "http://127.0.0.1:$apiPort/"
}
if ($sigUp) {
  Test-Endpoint "SIG  GET /health"   "http://127.0.0.1:$sigPort/health"    "edunova-x-production"
  Test-Endpoint "SIG  GET / (root)"  "http://127.0.0.1:$sigPort/"
  try {
    $r = Invoke-WebRequest -Uri "http://127.0.0.1:$sigPort/socket.io/?EIO=4&transport=polling" -TimeoutSec 10 -UseBasicParsing -Headers @{ Origin = "https://edunova-x.vercel.app" }
    if ($r.StatusCode -eq 200 -and $r.Content -match '^0\{') { Write-Ok "SIG  Socket.IO handshake - HTTP 200 (Engine.IO OK)" }
    else { Write-Bad "SIG  Socket.IO handshake - HTTP $($r.StatusCode) (expected Engine.IO 0{...})" }
  } catch { Write-Bad "SIG  Socket.IO handshake - $($_.Exception.Message)" }
}
if ($aiUp) { Test-Endpoint "AI   GET /health" "http://127.0.0.1:$aiPort/health" "edunova-x-production" }

Write-Host ""
if ($fail -gt 0) {
  Write-Host "============================================================" -ForegroundColor Red
  Write-Host ("[FAIL] LOCAL SMOKE TEST FAILED - {0} check(s) failed (passed: {1}). Fix and rerun." -f $fail, $pass) -ForegroundColor Red
  Write-Host "  Logs: $env:TEMP\edunova-api.log, edunova-signal.log, edunova-ai.log"
  Write-Host "============================================================" -ForegroundColor Red
  exit 1
}
Write-Host "============================================================" -ForegroundColor Green
Write-Host ("[PASS] LOCAL SMOKE TEST PASSED - {0} checks OK, zero 404s." -f $pass) -ForegroundColor Green
Write-Host "============================================================" -ForegroundColor Green
exit 0
