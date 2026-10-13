#Requires -Version 5.1
<#
.SYNOPSIS
  Build the IVY per-user Windows installer from a clean checkout.

.DESCRIPTION
  One command produces IVY-Setup-<version>.exe. It:
    1. Reads the version from windows/Ivy.App/Ivy.App.csproj (<Version>) so the
       version lives in exactly one place.
    2. Publishes windows/Ivy.App/Ivy.App.csproj self-contained for win-x64 into a
       clean staging folder (default windows/installer/publish, gitignored).
    3. Makes sure Inno Setup's ISCC.exe is available, installing it via winget if
       it is not already on the machine.
    4. Makes sure the WebView2 Evergreen bootstrapper is present in
       windows/installer/redist, downloading it if it is not.
    5. Runs ISCC with the version and publish folder, writing the installer to
       windows/installer/out (gitignored). Prints the final path and size.

  Any failing step stops the script with a clear message.

.PARAMETER PublishDir
  Where to stage the self-contained publish. Defaults to windows/installer/publish.

.EXAMPLE
  pwsh windows/tools/build-installer.ps1
#>
[CmdletBinding()]
param(
    [string]$PublishDir
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Fail([string]$msg) {
    Write-Error "build-installer: $msg"
    exit 1
}

function Info([string]$msg) {
    Write-Host "build-installer: $msg" -ForegroundColor Cyan
}

# --- Resolve repo paths (this script lives in windows/tools) -----------------
$ScriptDir   = Split-Path -Parent $MyInvocation.MyCommand.Path
$WindowsDir  = Split-Path -Parent $ScriptDir            # .../windows
$RepoRoot    = Split-Path -Parent $WindowsDir           # repo root
$InstallerDir = Join-Path $WindowsDir 'installer'
$Csproj      = Join-Path $WindowsDir 'Ivy.App\Ivy.App.csproj'
$IssFile     = Join-Path $InstallerDir 'Ivy.iss'
$RedistDir   = Join-Path $InstallerDir 'redist'
$WebView2Bootstrapper = Join-Path $RedistDir 'MicrosoftEdgeWebView2Setup.exe'
$OutDir      = Join-Path $InstallerDir 'out'

if (-not $PublishDir) { $PublishDir = Join-Path $InstallerDir 'publish' }

if (-not (Test-Path $Csproj))  { Fail "cannot find Ivy.App.csproj at $Csproj" }
if (-not (Test-Path $IssFile)) { Fail "cannot find Inno Setup script at $IssFile" }

# --- 1. Read the version from the csproj -------------------------------------
Info "reading version from $Csproj"
[xml]$csprojXml = Get-Content -Raw -Path $Csproj
$version = ($csprojXml.Project.PropertyGroup | ForEach-Object { $_.Version } | Where-Object { $_ }) | Select-Object -First 1
if (-not $version) { Fail "no <Version> element found in $Csproj" }
$version = ([string]$version).Trim()
Info "version = $version"

# --- 2. dotnet publish (self-contained, win-x64) into a clean staging dir -----
if (-not (Get-Command dotnet -ErrorAction SilentlyContinue)) {
    Fail "the .NET SDK (dotnet) is not on PATH; install the .NET 8 SDK to build"
}

if (Test-Path $PublishDir) {
    Info "cleaning existing publish folder $PublishDir"
    Remove-Item -Recurse -Force $PublishDir
}
New-Item -ItemType Directory -Force -Path $PublishDir | Out-Null

Info "publishing Ivy.App self-contained for win-x64 (this takes a while)..."
& dotnet publish $Csproj `
    -c Release `
    -r win-x64 `
    --self-contained true `
    -o $PublishDir
if ($LASTEXITCODE -ne 0) { Fail "dotnet publish failed (exit $LASTEXITCODE)" }

$publishedExe = Join-Path $PublishDir 'Ivy.App.exe'
if (-not (Test-Path $publishedExe)) { Fail "publish did not produce Ivy.App.exe in $PublishDir" }
Info "publish OK -> $PublishDir"

# --- 3. Ensure ISCC (Inno Setup) is available --------------------------------
function Find-Iscc {
    $candidates = @(
        (Join-Path ${env:ProgramFiles(x86)} 'Inno Setup 6\ISCC.exe'),
        (Join-Path $env:ProgramFiles 'Inno Setup 6\ISCC.exe'),
        # winget installs Inno Setup per-user here when it has no admin rights.
        (Join-Path $env:LOCALAPPDATA 'Programs\Inno Setup 6\ISCC.exe')
    )
    foreach ($c in $candidates) {
        if ($c -and (Test-Path $c)) { return $c }
    }
    $onPath = Get-Command ISCC.exe -ErrorAction SilentlyContinue
    if ($onPath) { return $onPath.Source }
    return $null
}

$iscc = Find-Iscc
if (-not $iscc) {
    Info "Inno Setup (ISCC.exe) not found; installing it with winget..."
    if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
        Fail "Inno Setup is not installed and winget is not available. Install Inno Setup 6 from https://jrsoftware.org/isinfo.php and re-run."
    }
    & winget install --id JRSoftware.InnoSetup --silent --accept-package-agreements --accept-source-agreements
    if ($LASTEXITCODE -ne 0) {
        Fail "winget failed to install Inno Setup (exit $LASTEXITCODE). If winget cannot run non-interactively here, install Inno Setup 6 manually and re-run."
    }
    $iscc = Find-Iscc
    if (-not $iscc) { Fail "Inno Setup was installed but ISCC.exe still could not be located" }
}
Info "ISCC = $iscc"

# --- 4. Ensure the WebView2 Evergreen bootstrapper is present ----------------
New-Item -ItemType Directory -Force -Path $RedistDir | Out-Null
if (-not (Test-Path $WebView2Bootstrapper)) {
    Info "WebView2 bootstrapper missing; downloading the official Evergreen bootstrapper..."
    $url = 'https://go.microsoft.com/fwlink/p/?LinkId=2124703'
    try {
        $oldPref = $ProgressPreference
        $ProgressPreference = 'SilentlyContinue'
        Invoke-WebRequest -Uri $url -OutFile $WebView2Bootstrapper -UseBasicParsing
        $ProgressPreference = $oldPref
    } catch {
        Fail "failed to download the WebView2 bootstrapper from $url : $($_.Exception.Message)"
    }
    if (-not (Test-Path $WebView2Bootstrapper)) { Fail "WebView2 bootstrapper download did not produce a file" }
}
Info "WebView2 bootstrapper = $WebView2Bootstrapper"

# --- 5. Run ISCC -------------------------------------------------------------
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
Info "compiling installer with ISCC..."
& $iscc `
    "/DMyAppVersion=$version" `
    "/DPublishDir=$PublishDir" `
    "/O$OutDir" `
    $IssFile
if ($LASTEXITCODE -ne 0) { Fail "ISCC failed (exit $LASTEXITCODE)" }

$setupExe = Join-Path $OutDir "IVY-Setup-$version.exe"
if (-not (Test-Path $setupExe)) { Fail "ISCC reported success but $setupExe was not produced" }

$sizeMB = [math]::Round((Get-Item $setupExe).Length / 1MB, 2)
Write-Host ""
Write-Host "build-installer: DONE" -ForegroundColor Green
Write-Host "  Installer : $setupExe"
Write-Host "  Size      : $sizeMB MB"
Write-Host "  Version   : $version"
