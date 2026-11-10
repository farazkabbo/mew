# Runs the web app (:3000) and API (:8000) locally against the STAGING Supabase project, with the
# fake model, so the sign-up and desktop sign-in flow can be tried end to end without touching
# production data or spending on Gemini or ElevenLabs. Clerk stays the development instance from
# .env.local.
#
# Put the staging values in .env.staging at the repo root (git ignores it):
#   NEXT_PUBLIC_SUPABASE_URL=https://<staging-ref>.supabase.co
#   NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=sb_publishable_...
#   SUPABASE_SECRET_KEY=sb_secret_...
#
#   powershell -ExecutionPolicy Bypass -File scripts\dev-staging.ps1
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$staging = Join-Path $root ".env.staging"
$productionRef = "gvwynloprjomqqovpoem"

if (-not (Test-Path $staging)) {
  Write-Error "Create .env.staging with the staging Supabase URL and keys (see the top of this script)."
}
foreach ($line in Get-Content $staging) {
  if ($line -match '^\s*([A-Z0-9_]+)\s*=\s*(.*)$') {
    Set-Item -Path "Env:$($Matches[1])" -Value $Matches[2].Trim().Trim('"')
  }
}
foreach ($name in "NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "SUPABASE_SECRET_KEY") {
  if (-not (Get-Item -Path "Env:$name" -ErrorAction SilentlyContinue).Value) {
    Write-Error "$name is missing from .env.staging."
  }
}
if ($env:NEXT_PUBLIC_SUPABASE_URL -like "*$productionRef*") {
  Write-Error "That's the production Supabase project. Use the staging one."
}

# Values set here win over .env.local (both servers only fill in what isn't set already).
$env:APP_ENV = "development"
$env:APP_ORIGIN = "http://localhost:3000"
$env:API_BASE_URL = "http://127.0.0.1:8000"
$env:ALLOWED_HOSTS = "127.0.0.1,localhost"
$env:NEB_FAKE_MODEL = "1"
$env:GEMINI_API_KEY = "fake-model"
$env:ELEVENLABS_API_KEY = "fake-model"
$env:NEB_QUOTA = "on"
$env:FREE_QUESTION_LIMIT = "8"

Write-Host "Web app http://localhost:3000, API http://127.0.0.1:8000, Supabase $env:NEXT_PUBLIC_SUPABASE_URL (staging), fake model on."
Set-Location $root
pnpm dev
