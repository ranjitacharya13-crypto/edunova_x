<#
 EduNova_X - Secret Extractor (PowerShell wrapper around extract-secrets.mjs)
 Pulls MONGO_URI / JWT_SECRET / email creds / TURN vars from the local .env
 files and formats them for Render Blueprint + Vercel injection.
 Usage:
   .\scripts\deploy\extract-secrets.ps1
#>
$ErrorActionPreference = "Stop"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw "Node.js is required (node not found on PATH)." }
& node (Join-Path $scriptDir "extract-secrets.mjs")
