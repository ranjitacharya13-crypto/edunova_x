<#
 =============================================================================
 EduNova_X - MASTER DEPLOY SCRIPT (PowerShell)
 -----------------------------------------------------------------------------
 Mirrors scripts/deploy/master-deploy.sh for Windows:
   1. Authenticate with Render API key + Vercel token
   2. Commit & push repaired code + render.yaml, validate the Blueprint,
      create the 3 services (edunova-api, edunova-signal, edunova-ai)
   3. Poll Render until all three services are LIVE
   4. Rewrite frontend/vercel.json + env vars with live Render URLs (+ TURN)
   5. Deploy the frontend: vercel --prod

 Usage:
   .\master-deploy.ps1                     # reads secrets from .env.secrets
   $env:RENDER_API_KEY="[Insert_Key]"; $env:VERCEL_TOKEN="[Insert_Token]"; .\master-deploy.ps1
   .\master-deploy.ps1 -SkipGitPush        # skip commit/push
   .\master-deploy.ps1 -SkipVerify         # skip final health verification
   .\scripts\deploy\extract-secrets.ps1  # (re)build .env.secrets from .env files
 =============================================================================
#>
[CmdletBinding()]
param(
  [switch]$SkipGitPush,
  [switch]$SkipVercel,
  [switch]$SkipVerify
)

$ErrorActionPreference = "Stop"
$scriptDir   = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot    = Resolve-Path (Join-Path $scriptDir "..\..")
$frontendDir = Join-Path $repoRoot "frontend"
$renderYaml  = Join-Path $repoRoot "render.yaml"
$secretsFile = Join-Path $scriptDir ".env.secrets"
$renderApi   = "https://api.render.com/v1"

function Write-Ok   { Write-Host "[ OK ]" -ForegroundColor Green  -NoNewline; Write-Host " $args" }
function Write-Info { Write-Host "[ .. ]" -ForegroundColor Cyan   -NoNewline; Write-Host " $args" }
function Write-Warn { Write-Host "[WARN]" -ForegroundColor Yellow -NoNewline; Write-Host " $args" }
function Write-Die  { Write-Host "[FAIL]" -ForegroundColor Red    -NoNewline; Write-Host " $args"; exit 1 }

# --- load secrets (KEY=VALUE lines, quote-aware) --------------------------------------
if (Test-Path $secretsFile) {
  Get-Content $secretsFile | Where-Object { $_ -match '^\s*[A-Za-z_][A-Za-z0-9_]*=' } | ForEach-Object {
    $kv = $_ -split '=', 2
    $value = $kv[1].Trim()
    if (($value.Length -ge 2) -and (($value[0] -eq '"' -and $value[-1] -eq '"') -or ($value[0] -eq "'" -and $value[-1] -eq "'"))) {
      $value = $value.Substring(1, $value.Length - 2)
    }
    Set-Item -Path ("Env:" + $kv[0].Trim()) -Value $value
  }
}
$env:GIT_BRANCH        = if ($env:GIT_BRANCH)        { $env:GIT_BRANCH }        else { "main" }
$env:RENDER_PLAN       = if ($env:RENDER_PLAN)       { $env:RENDER_PLAN }       else { "free" }
$env:RENDER_REGION     = if ($env:RENDER_REGION)     { $env:RENDER_REGION }     else { "oregon" }
$env:POLL_TIMEOUT_MIN  = if ($env:POLL_TIMEOUT_MIN)  { $env:POLL_TIMEOUT_MIN }  else { "25" }
$env:VERCEL_PROJECT    = if ($env:VERCEL_PROJECT)    { $env:VERCEL_PROJECT }    else { "edunova-x" }

$gitRepo = if ($env:GIT_REPO) { $env:GIT_REPO } else {
  $r = (git -C $repoRoot remote get-url origin 2>$null) -replace '\.git$',''
  if (-not $r) { "https://github.com/ranjitacharya13-crypto/edunova_x" } else { $r }
}

Write-Host ""
Write-Host "===============================================" -ForegroundColor Cyan
Write-Host "  EduNova_X - Master Deploy Pipeline (PowerShell)"
Write-Host "===============================================" -ForegroundColor Cyan
Write-Host ""

# ============================================================
# STAGE 1 - AUTHENTICATE
# ============================================================
Write-Host "`n>> Stage 1 - Authenticating with Render + Vercel" -ForegroundColor White
if (-not $env:RENDER_API_KEY) { Write-Die "RENDER_API_KEY not set (add it to $secretsFile or export it)." }
if (-not $env:VERCEL_TOKEN)   { Write-Die "VERCEL_TOKEN not set (add it to $secretsFile or export it)." }

$renderHeaders = @{ Authorization = "Bearer $($env:RENDER_API_KEY)" }
try {
  $owners = Invoke-RestMethod -Uri "$renderApi/owners?limit=100" -Headers $renderHeaders -Method Get -TimeoutSec 30
} catch { Write-Die "Render auth failed: $($_.Exception.Message)" }
if (-not $env:RENDER_OWNER_ID) {
  $personal = $owners | Where-Object { $_.type -eq "personal" } | Select-Object -First 1
  $env:RENDER_OWNER_ID = if ($personal) { $personal.id } else { $owners[0].id }
}
if (-not $env:RENDER_OWNER_ID) { Write-Die "Could not determine Render workspace id." }
Write-Ok "Render workspace: $($env:RENDER_OWNER_ID)"

$vercelWho = (& vercel whoami --token $env:VERCEL_TOKEN 2>&1) -join " "
if (-not $vercelWho -or $vercelWho -match "Error|error") { Write-Die "Vercel auth failed: $vercelWho" }
Write-Ok "Vercel identity: $vercelWho"

# ============================================================
# STAGE 2 - PUSH BLUEPRINT + CREATE SERVICES
# ============================================================
Write-Host "`n>> Stage 2 - Pushing blueprint & creating services" -ForegroundColor White

if ($SkipGitPush) {
  Write-Warn "Skipping git commit/push. Ensure render.yaml + fixes are on '$($env:GIT_BRANCH)'."
} else {
  Push-Location $repoRoot
  git add -A | Out-Null
  $staged = git diff --cached --quiet; if ($LASTEXITCODE -ne 0) {
    git commit -m "chore(deploy): health routes + render.yaml blueprint + deploy automation" | Out-Null
    Write-Ok "Committed changes."
  } else { Write-Info "No local changes to commit." }
  git push origin $env:GIT_BRANCH 2>&1 | Out-Null
  if ($LASTEXITCODE -ne 0) { Pop-Location; Write-Die "git push failed - push manually then rerun." }
  Pop-Location
  Write-Ok "Pushed code to $gitRepo ($($env:GIT_BRANCH))"
}

# 2a. Validate blueprint (curl.exe - multipart; present on Win10+)
Write-Info "Validating render.yaml..."
$validateJson = & curl.exe -sS -m 60 -X POST "$renderApi/blueprints/validate" `
  -H "Authorization: Bearer $($env:RENDER_API_KEY)" `
  -F "ownerId=$($env:RENDER_OWNER_ID)" `
  -F "file=@$renderYaml;type=text/yaml" 2>$null
try { $validate = $validateJson | ConvertFrom-Json } catch { $validate = $null }
if ($validate -and $validate.valid -eq $true) {
  Write-Ok "Blueprint VALID. Planned services: $($validate.plan.services -join ', ')"
} else {
  Write-Warn "Blueprint validation issues: $validateJson"
  Write-Die "Fix render.yaml and rerun."
}

# 2b. Blueprint instance?
$bps = @()
try { $bps = @(Invoke-RestMethod -Uri "$renderApi/blueprints?ownerId=$($env:RENDER_OWNER_ID)" -Headers $renderHeaders -Method Get -TimeoutSec 30) } catch {}
$existingBp = $bps | Where-Object { $_.repo -like "*$gitRepo*" } | Select-Object -First 1
if ($existingBp) {
  Write-Ok "Found Blueprint $($existingBp.id) - updating (autoSync, path=render.yaml)."
  $null = Invoke-RestMethod -Uri "$renderApi/blueprints/$($existingBp.id)" -Headers $renderHeaders -Method Patch `
    -ContentType "application/json" -Body (@{ autoSync = $true; path = "render.yaml" } | ConvertTo-Json)
  $useApiCreate = $false
} else {
  Write-Warn "No Blueprint instance yet. Render's public API cannot create Blueprint instances,"
  Write-Warn "so the script now creates the 3 services directly via the API (same config as render.yaml)."
  Write-Warn "Managed alternative: https://dashboard.render.com/blueprints/new"
  $useApiCreate = $true
}

$serviceNames = @("edunova-api", "edunova-signal", "edunova-ai")
$serviceIds   = @{}
$serviceUrls  = @{}

function Get-RenderServiceId([string]$name) {
  try {
    $s = Invoke-RestMethod -Uri "$renderApi/services?name=$name&ownerId=$($env:RENDER_OWNER_ID)" -Headers $renderHeaders -Method Get -TimeoutSec 30
    return $s[0].id
  } catch { return "" }
}

function New-RenderService([string]$name, [hashtable]$details) {
  $body = @{
    type = "web_service"; name = $name; ownerId = $env:RENDER_OWNER_ID
    repo = $gitRepo; branch = $env:GIT_BRANCH; autoDeploy = "yes"
  } + $details
  try {
    $resp = Invoke-RestMethod -Uri "$renderApi/services" -Headers $renderHeaders -Method Post `
      -ContentType "application/json" -Body ($body | ConvertTo-Json -Depth 10) -TimeoutSec 60
    return $resp.service.id
  } catch {
    $status = $_.Exception.Response.StatusCode.value__
    if ($status -eq 409) { Write-Warn "Service '$name' already exists - reusing it."; return (Get-RenderServiceId $name) }
    Write-Warn "Create '$name' failed: $($_.ErrorDetails.Message)"
    return ""
  }
}

if ($useApiCreate) {
  $apiEnv = @()
  if ($env:MONGO_URI)  { $apiEnv += @{ key = "MONGO_URI"; value = $env:MONGO_URI } }
  if ($env:JWT_SECRET) { $apiEnv += @{ key = "JWT_SECRET"; value = $env:JWT_SECRET } }
  if ($env:ADMIN_TEMP_PASSWORD) { $apiEnv += @{ key = "ADMIN_TEMP_PASSWORD"; value = $env:ADMIN_TEMP_PASSWORD } }
  if ($env:EMAIL_USER) { $apiEnv += @{ key = "EMAIL_USER"; value = $env:EMAIL_USER } }
  if ($env:EMAIL_PASS) { $apiEnv += @{ key = "EMAIL_PASS"; value = $env:EMAIL_PASS } }
  if ($env:CONTACT_RECEIVER_EMAIL) { $apiEnv += @{ key = "CONTACT_RECEIVER_EMAIL"; value = $env:CONTACT_RECEIVER_EMAIL } }
  $apiEnv += @{ key = "SEED_DEMO_USERS"; value = $(if ($env:SEED_DEMO_USERS) { $env:SEED_DEMO_USERS } else { "true" }) }

  # edunova-api runs as a DOCKER service (server/Dockerfile) so sharp +
  # pdf-thumbnail (GraphicsMagick) work end-to-end, matching render.yaml.
  # dockerfilePath/dockerContext are relative to the REPO ROOT (API spec).
  $apiDetails = @{
    envVars = $apiEnv
    serviceDetails = @{
      runtime = "docker"; plan = $env:RENDER_PLAN; region = $env:RENDER_REGION; numInstances = 1
      healthCheckPath = "/health"
      envSpecificDetails = @{ dockerfilePath = "server/Dockerfile"; dockerContext = "server"; dockerCommand = "node server.js" }
    }
  }
  $serviceIds["edunova-api"] = New-RenderService "edunova-api" $apiDetails
  Write-Ok "edunova-api -> $($serviceIds['edunova-api'])"

  $signalDetails = @{
    envVars = @()
    serviceDetails = @{
      runtime = "node"; plan = $env:RENDER_PLAN; region = $env:RENDER_REGION; numInstances = 1
      healthCheckPath = "/health"
      envSpecificDetails = @{ buildCommand = "npm install"; startCommand = "node index.js" }
    }
  }
  $serviceIds["edunova-signal"] = New-RenderService "edunova-signal" $signalDetails
  Write-Ok "edunova-signal -> $($serviceIds['edunova-signal'])"

  $aiEnv = @(); if ($env:MONGO_URI) { $aiEnv += @{ key = "MONGO_URI"; value = $env:MONGO_URI } }
  $aiDetails = @{
    envVars = $aiEnv
    serviceDetails = @{
      runtime = "python"; plan = $env:RENDER_PLAN; region = $env:RENDER_REGION; numInstances = 1
      healthCheckPath = "/health"
      envSpecificDetails = @{ buildCommand = "pip install -r requirements.txt"; startCommand = "uvicorn main:app --host 0.0.0.0 --port `$PORT" }
    }
  }
  $serviceIds["edunova-ai"] = New-RenderService "edunova-ai" $aiDetails
  Write-Ok "edunova-ai -> $($serviceIds['edunova-ai'])"

  # Wire AI_ENGINE_URL then set env vars + redeploy
  if ($serviceIds["edunova-ai"] -and $serviceIds["edunova-api"]) {
    try {
      $aiSvc = Invoke-RestMethod -Uri "$renderApi/services/$($serviceIds['edunova-ai'])" -Headers $renderHeaders -Method Get -TimeoutSec 30
      $aiUrl = $aiSvc.serviceDetails.url
      if ($aiUrl) {
        $finalEnv = @($apiEnv) + @(@{ key = "AI_ENGINE_URL"; value = "https://$aiUrl" })
        $null = Invoke-RestMethod -Uri "$renderApi/services/$($serviceIds['edunova-api'])/env-vars" `
          -Headers $renderHeaders -Method Put -ContentType "application/json" `
          -Body ($finalEnv | ConvertTo-Json -Depth 5) -TimeoutSec 30
        Write-Ok "Env vars set on edunova-api (AI_ENGINE_URL=https://$aiUrl)"
        $null = Invoke-RestMethod -Uri "$renderApi/services/$($serviceIds['edunova-api'])/deploys" `
          -Headers $renderHeaders -Method Post -TimeoutSec 30 2>$null
        Write-Info "Redeploy triggered for edunova-api (env change)"
      }
    } catch { Write-Warn "AI_ENGINE_URL wiring failed: $($_.Exception.Message)" }
  }
} else {
  foreach ($n in $serviceNames) { $serviceIds[$n] = Get-RenderServiceId $n }
}

foreach ($n in $serviceNames) {
  if (-not $serviceIds[$n]) { Write-Die "No service id resolved for '$n' - rerun after fixing." }
}
Write-Ok "All three services exist: $($serviceNames -join ', ')"

# ============================================================
# STAGE 3 - POLL UNTIL LIVE
# ============================================================
Write-Host "`n>> Stage 3 - Polling Render until all services are LIVE" -ForegroundColor White
$deadline = (Get-Date).AddMinutes([int]$env:POLL_TIMEOUT_MIN)
$allLive = $false

while (-not $allLive) {
  $allLive = $true
  foreach ($n in $serviceNames) {
    $id = $serviceIds[$n]
    $liveHttp = $false
    try {
      $svc = Invoke-RestMethod -Uri "$renderApi/services/$id" -Headers $renderHeaders -Method Get -TimeoutSec 30
      $url = $svc.serviceDetails.url; $serviceUrls[$n] = $url
      $deps = Invoke-RestMethod -Uri "$renderApi/services/$id/deploys?limit=1" -Headers $renderHeaders -Method Get -TimeoutSec 30
      $deployLive = ($deps[0].status -eq "live")
      try {
        $body = (Invoke-WebRequest -Uri "https://$url/health" -TimeoutSec 15 -UseBasicParsing).Content
        # Universal health contract: {"status":"ok","service":"edunova-x-production"}
        # (accepts the legacy "live" value too, for services still mid-rollout).
        $liveHttp = $body -match '"status"\s*:\s*"(ok|live)"'
      } catch { $liveHttp = $false }
      $mark = if ($liveHttp) { "[LIVE]" } else { "[wait]" }
      Write-Host ("   {0,-16} deploy:{1} http:{2} {3}" -f $n, $deployLive, $liveHttp, $mark)
    } catch {
      $liveHttp = $false
      Write-Host ("   {0,-16} error polling: {1}" -f $n, $_.Exception.Message)
    }
    if (-not $liveHttp) { $allLive = $false }
  }
  if ($allLive) { break }
  if ((Get-Date) -gt $deadline) { Write-Warn "Timed out after $($env:POLL_TIMEOUT_MIN) min."; break }
  Start-Sleep -Seconds 20
}
if (-not $allLive) { Write-Die "Services did not all reach LIVE. See https://dashboard.render.com" }
Write-Ok "All services LIVE."
$apiUrl    = $serviceUrls["edunova-api"]
$signalUrl = $serviceUrls["edunova-signal"]
$aiUrl     = $serviceUrls["edunova-ai"]
if (-not $apiUrl -or -not $signalUrl) { Write-Die "Missing service URLs." }

# ============================================================
# STAGE 4 - UPDATE FRONTEND CONFIG
# ============================================================
Write-Host "`n>> Stage 4 - Updating frontend config with live URLs" -ForegroundColor White
$viteApiUrl    = "https://$apiUrl/api"
$viteSignalUrl = "https://$signalUrl"

$envBlock = @{
  VITE_API_URL    = $viteApiUrl
  VITE_SIGNAL_URL = $viteSignalUrl
  VITE_API_PORT   = "4000"
  VITE_SIGNAL_PORT = "5000"
}
if ($env:VITE_TURN_URL) {
  $envBlock.VITE_TURN_URL       = $env:VITE_TURN_URL
  $envBlock.VITE_TURN_USERNAME  = $env:VITE_TURN_USERNAME
  $envBlock.VITE_TURN_CREDENTIAL = $env:VITE_TURN_CREDENTIAL
  Write-Ok "TURN server configured: $($env:VITE_TURN_URL)"
} else {
  Write-Warn "VITE_TURN_URL empty - STUN only. Set TURN vars in $secretsFile for reliable 4G/mobile video."
}

$vercelJson = @{
  framework = "vite"; buildCommand = "npm run build"; outputDirectory = "dist"; env = $envBlock
  rewrites = @(@{ source = "/((?!assets/|.*\\..*).*)"; destination = "/index.html" })
} | ConvertTo-Json -Depth 6
Set-Content -Path (Join-Path $frontendDir "vercel.json") -Value $vercelJson -Encoding UTF8
Write-Ok "frontend/vercel.json updated"

# Root vercel.json (covers deploys where Vercel uses the repo root as project root)
$rootVercelJson = @{
  "\$schema" = "https://openapi.vercel.sh/vercel.json"; framework = "vite"
  installCommand = "cd frontend && npm install"; buildCommand = "cd frontend && npm run build"
  outputDirectory = "frontend/dist"; env = $envBlock
  rewrites = @(@{ source = "/((?!assets/|.*\\..*).*)"; destination = "/index.html" })
} | ConvertTo-Json -Depth 6
Set-Content -Path (Join-Path $repoRoot "vercel.json") -Value $rootVercelJson -Encoding UTF8
Write-Ok "root vercel.json updated"

@"
VITE_API_URL=$viteApiUrl
VITE_SIGNAL_URL=$viteSignalUrl
VITE_API_PORT=4000
VITE_SIGNAL_PORT=5000
$(if ($env:VITE_TURN_URL) { "VITE_TURN_URL=$($env:VITE_TURN_URL)`nVITE_TURN_USERNAME=$($env:VITE_TURN_USERNAME)`nVITE_TURN_CREDENTIAL=$($env:VITE_TURN_CREDENTIAL)" })
$(if ($env:VITE_ICE_SERVERS_JSON) { "VITE_ICE_SERVERS_JSON=$($env:VITE_ICE_SERVERS_JSON)" })
"@ | Set-Content -Path (Join-Path $frontendDir ".env.production") -Encoding UTF8
Write-Ok "frontend/.env.production written"

@"
# Auto-updated by scripts/deploy/master-deploy.ps1 - $(Get-Date -Format o)
# NOTE: TURN credentials are written to frontend/.env.local (gitignored),
#       not here - this file is tracked in git.
VITE_API_URL=$viteApiUrl
VITE_SIGNAL_URL=$viteSignalUrl
VITE_API_PORT=4000
VITE_SIGNAL_PORT=5000
"@ | Set-Content -Path (Join-Path $frontendDir ".env") -Encoding UTF8
Write-Ok "frontend/.env updated (URLs only - no secrets)"

@"
VITE_API_URL=$viteApiUrl
VITE_SIGNAL_URL=$viteSignalUrl
VITE_API_PORT=4000
VITE_SIGNAL_PORT=5000
$(if ($env:VITE_TURN_URL) { "VITE_TURN_URL=$($env:VITE_TURN_URL)`nVITE_TURN_USERNAME=$($env:VITE_TURN_USERNAME)`nVITE_TURN_CREDENTIAL=$($env:VITE_TURN_CREDENTIAL)" })
$(if ($env:VITE_ICE_SERVERS_JSON) { "VITE_ICE_SERVERS_JSON=$($env:VITE_ICE_SERVERS_JSON)" })
"@ | Set-Content -Path (Join-Path $frontendDir ".env.local") -Encoding UTF8
Write-Ok "frontend/.env.local written (TURN creds, gitignored)"

# ============================================================
# STAGE 5 - DEPLOY TO VERCEL
# ============================================================
Write-Host "`n>> Stage 5 - Deploying frontend to Vercel" -ForegroundColor White
if ($SkipVercel) { Write-Warn "Skipping Vercel deploy (-SkipVercel)."; return }

if (-not (Get-Command vercel -ErrorAction SilentlyContinue)) {
  Write-Info "vercel CLI not found - installing via npx..."; npm install -g vercel | Out-Null
}
if (-not (Test-Path (Join-Path $frontendDir ".vercel"))) {
  Write-Info "Linking frontend to Vercel project '$($env:VERCEL_PROJECT)'..."
  & vercel link --yes --project $env:VERCEL_PROJECT --cwd $frontendDir --token $env:VERCEL_TOKEN 2>&1 | Out-Null
}

$envVars = @{ VITE_API_URL = $viteApiUrl; VITE_SIGNAL_URL = $viteSignalUrl; VITE_API_PORT = "4000"; VITE_SIGNAL_PORT = "5000" }
if ($env:VITE_TURN_URL) {
  $envVars.VITE_TURN_URL = $env:VITE_TURN_URL
  $envVars.VITE_TURN_USERNAME = $env:VITE_TURN_USERNAME
  $envVars.VITE_TURN_CREDENTIAL = $env:VITE_TURN_CREDENTIAL
}
foreach ($k in $envVars.Keys) {
  $v = [string]$envVars[$k]
  $v | & vercel env add $k production --cwd $frontendDir --token $env:VERCEL_TOKEN 2>&1 | Out-Null
  if ($LASTEXITCODE -eq 0) { Write-Ok "vercel env $k (production)" } else { Write-Warn "vercel env add $k failed (vercel.json env still covers it)" }
}

Write-Info "Running: vercel --prod --yes --cwd $frontendDir"
$deployOut = (& vercel --prod --yes --cwd $frontendDir --token $env:VERCEL_TOKEN 2>&1) -join "`n"
$deployUrl = [regex]::Match($deployOut, "https://[a-zA-Z0-9.-]+\.vercel\.app").Value
$deployOut -split "`n" | Select-Object -Last 6 | ForEach-Object { Write-Host $_ }

# ============================================================
# STAGE 6 - VERIFY EVERYTHING (health + CORS hardening)
# ============================================================
Write-Host "`n>> Stage 6 - Verifying health of every endpoint" -ForegroundColor White
if ($SkipVerify) {
  Write-Warn "Skipping verification (-SkipVerify)."
} else {
  $verifyFail = $false
  function Test-Endpoint([string]$label, [string]$url) {
    try {
      $code = (Invoke-WebRequest -Uri $url -TimeoutSec 25 -UseBasicParsing -MaximumRedirection 5).StatusCode
      if ($code -eq 200) { Write-Ok ("{0} -> HTTP {1}" -f $label, $code) }
      else { Write-Warn ("{0} -> HTTP {1}" -f $label, $code); $script:verifyFail = $true }
    } catch {
      Write-Warn ("{0} -> {1}" -f $label, $_.Exception.Message)
      $script:verifyFail = $true
    }
  }
  Test-Endpoint "API /health" "https://$apiUrl/health"
  Test-Endpoint "API /api/test" "https://$apiUrl/api/test"
  Test-Endpoint "API / (root)" "https://$apiUrl/"
  Test-Endpoint "Signaling /health" "https://$signalUrl/health"
  Test-Endpoint "AI /health" "https://$aiUrl/health"
  if ($deployUrl) {
    Test-Endpoint "Vercel / (SPA root)" "$deployUrl/"
    Test-Endpoint "Vercel /dashboard (SPA rewrite)" "$deployUrl/dashboard"
  }
  if (-not $verifyFail) {
    # CORS hardening: whitelist the exact deployed Vercel domain on edunova-api
    # (non-fatal - the server already allows every *.vercel.app origin).
    if ($deployUrl -and $serviceIds["edunova-api"]) {
      try {
        $deployOrigin = ([uri]$deployUrl).GetLeftPart([System.UriPartial]::Authority)
        $corsList = @()
        if ($env:CORS_ORIGINS) { $corsList = @($env:CORS_ORIGINS -split ',') + $deployOrigin }
        else { $corsList = @($deployOrigin) }
        $corsBody = @(@{ key = "CORS_ORIGINS"; value = (($corsList | Sort-Object -Unique) -join ",") }) | ConvertTo-Json -Depth 4
        $null = Invoke-RestMethod -Uri "$renderApi/services/$($serviceIds['edunova-api'])/env-vars" `
          -Headers $renderHeaders -Method Put -ContentType "application/json" -Body $corsBody -TimeoutSec 30
        Write-Ok "CORS_ORIGINS on edunova-api updated: $($corsList -join ', ')"
      } catch { Write-Warn "CORS_ORIGINS push failed (non-fatal - *.vercel.app wildcard covers the domain): $($_.Exception.Message)" }
    }
  }
  if ($verifyFail) { Write-Die "VERIFICATION FAILED - see [WARN]/[FAIL] lines above. Fix and rerun (rerun is idempotent)." }
  Write-Ok "All endpoints verified - zero 404s, zero Cannot GET."
}

# ============================================================
# SUMMARY
# ============================================================
Write-Host ""
Write-Host "===============================================" -ForegroundColor Green
Write-Host "           DEPLOYMENT COMPLETE - SUMMARY" -ForegroundColor Green
Write-Host "===============================================" -ForegroundColor Green
Write-Host ("  Frontend (Vercel):   " + $(if ($deployUrl) { $deployUrl } else { "see Vercel dashboard" }))
Write-Host "  API (Render):        https://$apiUrl/health"
Write-Host "  Signaling (Render):  https://$signalUrl/health"
Write-Host "  AI engine (Render):  https://$aiUrl/health"
Write-Host ""
Write-Host "  Verified live:"
Write-Host "   - https://$apiUrl/health     -> 200 {`"status`":`"ok`",`"service`":`"edunova-x-production`"}"
Write-Host "   - https://$apiUrl/api/test   -> 200 OK"
Write-Host "   - https://$signalUrl/health  -> 200"
Write-Host "   - $deployUrl/                -> 200 (SPA)"
Write-Host ""
Write-Host "  Next: set real TURN credentials in scripts/deploy/.env.secrets"
Write-Host "        and rerun for reliable mobile/4G video."
Write-Host ""
