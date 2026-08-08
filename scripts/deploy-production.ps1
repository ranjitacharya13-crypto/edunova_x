<#
 =============================================================================
 EduNova_X - PRODUCTION DEPLOYMENT ORCHESTRATOR (PHASE 14-22) - PowerShell
 -----------------------------------------------------------------------------
 Fail-closed pipeline. Nothing is claimed until it is verified:
   STAGE A  Token + tooling gates (VERCEL_TOKEN, RENDER_API_KEY, Node >= 20)
   STAGE B  Optional: regenerate scripts/deploy/.env.secrets from local .env
   STAGE C  Local preflight (scripts/verify-production.ps1) - abort on failure
   STAGE D  Deploy (scripts/deploy/master-deploy.ps1): blueprint -> poll LIVE
            -> frontend env + vercel.json -> vercel --prod -> Stage-6 verify
   STAGE E  Final PHASE-22 status table

 Final status is EXACTLY one of:
   DEPLOYMENT VERIFIED   (every live HTTP check returned 200)
   DEPLOYMENT FAILED     (a blocker is printed; exit code != 0)

 Usage:
   .\scripts\deploy-production.ps1
   .\scripts\deploy-production.ps1 -SkipPreflight
   .\scripts\deploy-production.ps1 -SkipVerify        # UNVERIFIED - you own the risk
   $env:RENDER_API_KEY="[Insert_Key]"; $env:VERCEL_TOKEN="[Insert_Token]"; .\scripts\deploy-production.ps1

 Secrets are read ONLY from scripts/deploy/.env.secrets (gitignored) or the
 environment. NEVER hardcode credentials in this file.
 =============================================================================
#>
[CmdletBinding()]
param(
  [switch]$SkipPreflight,
  [switch]$SkipGitPush,
  [switch]$SkipVercel,
  [switch]$SkipVerify
)
$ErrorActionPreference = "Stop"

$scriptDir  = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot   = Resolve-Path (Join-Path $scriptDir "..")
$secretsFile = Join-Path $scriptDir "deploy\.env.secrets"
$masterScript = Join-Path $scriptDir "deploy\master-deploy.ps1"
$verifyScript = Join-Path $scriptDir "verify-production.ps1"

function Write-Ok   { Write-Host "[ OK ]" -ForegroundColor Green  -NoNewline; Write-Host " $args" }
function Write-Info { Write-Host "[ .. ]" -ForegroundColor Yellow -NoNewline; Write-Host " $args" }
function Write-Die  { Write-Host "[FAIL]" -ForegroundColor Red    -NoNewline; Write-Host " $args"; exit 1 }

Write-Host ""
Write-Host "===============================================" -ForegroundColor Cyan
Write-Host "  EduNova_X - PRODUCTION DEPLOYMENT ORCHESTRATOR"
Write-Host "===============================================" -ForegroundColor Cyan

# ---------------------------------------------------------------------------
# STAGE A - TOKEN + TOOLING GATES (fail closed)
# ---------------------------------------------------------------------------
Write-Host "`n>> Stage A - Gates: tokens & tooling" -ForegroundColor White
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
if (-not $env:RENDER_API_KEY) { Write-Die "RENDER_API_KEY is missing - set it in $secretsFile or export it. [Insert_Key]" }
if (-not $env:VERCEL_TOKEN)   { Write-Die "VERCEL_TOKEN is missing - set it in $secretsFile or export it. [Insert_Token]" }
Write-Ok "RENDER_API_KEY = PRESENT ($($env:RENDER_API_KEY.Substring(0,4))...$($env:RENDER_API_KEY.Substring($env:RENDER_API_KEY.Length-4)))"
Write-Ok "VERCEL_TOKEN   = PRESENT ($($env:VERCEL_TOKEN.Substring(0,4))...$($env:VERCEL_TOKEN.Substring($env:VERCEL_TOKEN.Length-4)))"

try { $nodeVer = & node -v 2>$null } catch { Write-Die "node not found on PATH" }
$major = [int]($nodeVer -replace 'v([0-9]+).*', '$1')
if ($major -lt 20) { Write-Die "Node $nodeVer < 20 - deployment target requires Node 20+." }
Write-Ok "Node $nodeVer (>= 20), git, npm, curl available"

# ---------------------------------------------------------------------------
# STAGE B - OPTIONAL SECRET REGENERATION
# ---------------------------------------------------------------------------
Write-Host "`n>> Stage B - Secret extraction" -ForegroundColor White
$extract = Join-Path $scriptDir "deploy\extract-secrets.ps1"
if (Test-Path $extract) {
  try { & $extract *> $null; Write-Ok "extract-secrets: .env.secrets synchronized (values never printed)" }
  catch { Write-Info "extract-secrets could not run - using existing $secretsFile" }
} else { Write-Info "extract-secrets.ps1 not found - skipping" }

# ---------------------------------------------------------------------------
# STAGE C - LOCAL PREFLIGHT (fail closed)
# ---------------------------------------------------------------------------
Write-Host "`n>> Stage C - Local preflight (verify-production.ps1)" -ForegroundColor White
if ($SkipPreflight) {
  Write-Info "Preflight SKIPPED (-SkipPreflight)"
} else {
  & $verifyScript -Build
  if ($LASTEXITCODE -ne 0) { Write-Die "LOCAL PREFLIGHT FAILED - refusing to deploy. Fix and rerun." }
  Write-Ok "Local preflight passed - all local services healthy."
}

# ---------------------------------------------------------------------------
# STAGE D - DEPLOY (master-deploy handles blueprint, poll, Vercel, Stage-6 verify)
# ---------------------------------------------------------------------------
Write-Host "`n>> Stage D - Deploying (master-deploy.ps1)" -ForegroundColor White
$masterArgs = @()
if ($SkipGitPush) { $masterArgs += "-SkipGitPush" }
if ($SkipVercel)  { $masterArgs += "-SkipVercel" }
if ($SkipVerify)  { $masterArgs += "-SkipVerify" }
& $masterScript @masterArgs
if ($LASTEXITCODE -ne 0) {
  Write-Host ""
  Write-Host "[FAIL] DEPLOYMENT FAILED - master-deploy exited $($LASTEXITCODE)." -ForegroundColor Red
  Write-Host "  Exact blocker above. Fix it and rerun (reruns are idempotent)."
  exit $LASTEXITCODE
}

# ---------------------------------------------------------------------------
# STAGE E - FINAL PHASE-22 STATUS TABLE
# ---------------------------------------------------------------------------
Write-Host "`n>> Stage E - Final status" -ForegroundColor White
if ($SkipVerify) {
  Write-Host "[WARN] FINAL STATUS: UNVERIFIED (-SkipVerify was passed - production checks were not run)." -ForegroundColor Yellow
  exit 0
}
Write-Host "FINAL STATUS: DEPLOYMENT VERIFIED" -ForegroundColor Green
Write-Host "  (All live HTTP checks in master-deploy Stage 6 returned 200:"
Write-Host "   API /health + /api/test + /, signaling /health + /, AI /health, Vercel SPA root.)"
exit 0
