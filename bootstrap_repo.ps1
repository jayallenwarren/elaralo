Param()

# ==========================
# === CONFIG: EDIT THESE ===
# ==========================
$GitHubUser = "jayallenwarren"     # your GitHub username/org
$RepoName   = "elaralo"            # new repository name to (re)create
$Visibility = "private"            # "private" or "public"
$UseGhCli   = $true                # set $true if you have GitHub CLI authed (gh auth login)

$AzureApp   = "elaralo-api-01"     # Azure Web App name
$BackendDir = "backend"            # path to FastAPI backend folder (must exist)

# Frontend (optional)
$BuildNext  = $false               # set $true to build Next.js and copy to backend/static
$NextDir    = "next-frontend"      # Next.js project folder (if used)

# ==========================
# === PRECHECKS ============
# ==========================
function Fail($msg) {
  Write-Error $msg
  exit 1
}

if (-not (Get-Command git -ErrorAction SilentlyContinue)) { Fail "git not found in PATH." }
if (-not (Test-Path $BackendDir)) { Fail "ERROR: '$BackendDir' not found. Run this script from your project root." }

# ==========================
# === .gitignore ===========
# ==========================
@"
# Node / Next.js
node_modules/
.next/
out/
dist/
next-frontend/node_modules/
next-frontend/.next/
next-frontend/out/

# Python
__pycache__/
.antenv/
antenv/
.env
.python_packages/

# OS/IDE
.DS_Store
Thumbs.db
.vscode/
.idea/
"@ | Set-Content -Encoding UTF8 .gitignore

# ==========================
# === OPTIONAL NEXT BUILD ==
# ==========================
if ($BuildNext -and (Test-Path $NextDir)) {
  if (Get-Command npm -ErrorAction SilentlyContinue) {
    Write-Host "Building Next.js static export in '$NextDir'..."
    Push-Location $NextDir
    # Prefer npm ci; fallback to npm install
    npm ci 2>$null; if ($LASTEXITCODE -ne 0) { npm install }
    # Expect package.json to run next build (and ideally export)
    npm run build
    Pop-Location

    # Copy export (default Next export path is 'out')
    $ExportPath = Join-Path $NextDir "out"
    if (-not (Test-Path $ExportPath)) {
      Write-Warning "No 'out' folder found after build. If you use 'next export', ensure your build creates ./out. Skipping static copy."
    } else {
      Write-Host "Copying static export into '$BackendDir/static'..."
      New-Item -ItemType Directory -Force -Path "$BackendDir/static" | Out-Null
      Remove-Item "$BackendDir/static/*" -Recurse -Force -ErrorAction SilentlyContinue
      Copy-Item "$ExportPath/*" "$BackendDir/static" -Recurse -Force -ErrorAction SilentlyContinue
    }
  } else {
    Write-Warning "npm not found; skipping Next build."
  }
}

# ==========================
# === WORKFLOW (ORYX) ======
# ==========================
New-Item -ItemType Directory -Force -Path ".github/workflows" | Out-Null
@'
name: Deploy Elaralo backend (Oryx)

on:
  push:
    branches: [ main ]
  workflow_dispatch:

jobs:
  deploy:
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@v4
      - name: Deploy to Azure Web App
        uses: azure/webapps-deploy@v3
        with:
          app-name: ELARALO_APP_NAME_REPLACE
          publish-profile: ${{ secrets.AZURE_WEBAPP_PUBLISH_PROFILE }}
          package: ${{ github.workspace }}/BACKEND_DIR_REPLACE
'@ | Set-Content -Encoding UTF8 ".github/workflows/deploy.yml"

# Replace placeholders safely (avoid interpolating ${{ ... }} in PowerShell)
(Get-Content ".github/workflows/deploy.yml") `
  -replace 'ELARALO_APP_NAME_REPLACE', [Regex]::Escape($AzureApp) `
  -replace 'BACKEND_DIR_REPLACE', [Regex]::Escape($BackendDir) `
  | Set-Content -Encoding UTF8 ".github/workflows/deploy.yml"

# Warn if backend/requirements.txt missing (Oryx needs it)
if (-not (Test-Path (Join-Path $BackendDir "requirements.txt"))) {
  Write-Warning "$BackendDir/requirements.txt not found. Oryx deployment will fail without it."
}

# ==========================
# === GIT INIT & CLEAN =====
# ==========================
if (-not (Test-Path ".git")) { git init | Out-Null }
git checkout -B main | Out-Null

# Ensure we never track heavy dirs if they were ever staged before
git rm -r --cached "next-frontend/node_modules" 2>$null
git rm -r --cached "next-frontend/.next" 2>$null
git rm -r --cached "next-frontend/out" 2>$null
git rm -r --cached "node_modules" 2>$null
git rm -r --cached "out" ".next" "dist" 2>$null

git add .
git commit -m "Initial commit: clean repo, Oryx deploy workflow, optional static site" | Out-Null

# ==========================
# === CREATE REMOTE & PUSH =
# ==========================
$RemoteUrl = "https://github.com/$GitHubUser/$RepoName.git"

if ($UseGhCli) {
  if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
    Fail "gh CLI not found. Install from https://cli.github.com/ or set `$UseGhCli = `$false."
  }
  Write-Host "Creating GitHub repo $GitHubUser/$RepoName ($Visibility) via gh CLI..."
  # If the repo already exists, this will error; we'll continue and just set remote
  gh repo create "$GitHubUser/$RepoName" --$Visibility --source . --disable-issues --disable-wiki --remote origin --push 2>$null | Out-Null
  if ($LASTEXITCODE -ne 0) {
    Write-Warning "gh repo create may have failed (it might already exist). Ensuring 'origin' remote is set…"
    if (-not (git remote | Select-String -Pattern "^origin$")) {
      git remote add origin $RemoteUrl
    }
    git push -u origin main
  }
} else {
  Write-Host "Skipping gh repo create. Ensure a GitHub repo exists at $RemoteUrl."
  if (-not (git remote | Select-String -Pattern "^origin$")) {
    git remote add origin $RemoteUrl
  }
  git push -u origin main
}

# ==========================
# === NEXT STEPS ===========
# ==========================
Write-Host "`nDone."
Write-Host "NEXT STEPS:"
Write-Host "1) In GitHub → Settings → Secrets and variables → Actions → add secret:"
Write-Host "     AZURE_WEBAPP_PUBLISH_PROFILE   (download from Azure Web App → Get publish profile)"
Write-Host "2) In Azure App Service → Configuration → App settings:"
Write-Host "     SCM_DO_BUILD_DURING_DEPLOYMENT = true"
Write-Host "3) Push any change (or Run workflow) to deploy via Oryx."
Write-Host "   API health (example): https://$AzureApp.azurewebsites.net/health"
Write-Host "   Static site (if copied): https://$AzureApp.azurewebsites.net/site/"
