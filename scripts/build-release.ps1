param(
    [string]$GatewayBaseUrl = "",
    [string]$GatewayModel = "deepseek-v4-flash",
    [string]$GatewayToken = "",
    [switch]$ConsoleRuntime
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$RuntimeProject = Join-Path $RepoRoot "services\runtime"
$TaskCenterDist = Join-Path $RepoRoot "apps\task-center\dist"
$ExtensionDist = Join-Path $RepoRoot "apps\extension\dist"
$SpecPath = Join-Path $RepoRoot "release\windows\xunlei-zhiqu.spec"
$InnoScript = Join-Path $RepoRoot "release\windows\XunleiZhiqu.iss"
$BuildRoot = Join-Path $RepoRoot "artifacts\build"
$PyInstallerDist = Join-Path $BuildRoot "dist"
$PyInstallerWork = Join-Path $BuildRoot "pyinstaller"
$RuntimeDir = Join-Path $PyInstallerDist "XunleiZhiqu"
$PortableStage = Join-Path $BuildRoot "portable"
$ReleaseDir = Join-Path $RepoRoot "artifacts\release"
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)

function Assert-Command([string]$Name) {
    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        throw "Missing required build command: $Name"
    }
}

function Invoke-Step([string]$Label, [scriptblock]$Action) {
    Write-Host ""
    Write-Host "==> $Label"
    & $Action
    if ($LASTEXITCODE -ne 0) {
        throw "$Label failed with exit code $LASTEXITCODE"
    }
}

function Find-InnoSetupCompiler {
    $command = Get-Command "ISCC.exe" -ErrorAction SilentlyContinue
    if ($command) {
        return $command.Source
    }

    $candidates = @()
    if (${env:ProgramFiles(x86)}) {
        $candidates += (Join-Path ${env:ProgramFiles(x86)} "Inno Setup 6\ISCC.exe")
    }
    if ($env:ProgramFiles) {
        $candidates += (Join-Path $env:ProgramFiles "Inno Setup 6\ISCC.exe")
    }
    if ($env:LOCALAPPDATA) {
        $candidates += (Join-Path $env:LOCALAPPDATA "Programs\Inno Setup 6\ISCC.exe")
    }

    foreach ($candidate in $candidates) {
        if (Test-Path $candidate) {
            return $candidate
        }
    }
    return $null
}

function Read-LocalSupplierKey {
    $envPath = Join-Path $RepoRoot ".env"
    if (-not (Test-Path $envPath)) {
        return ""
    }
    foreach ($line in Get-Content $envPath) {
        if ($line -match '^\s*MODEL_API_KEY\s*=\s*(.*)\s*$') {
            return $Matches[1].Trim().Trim('"').Trim("'")
        }
    }
    return ""
}

function Assert-ReleaseTree([string]$Path) {
    $forbidden = Get-ChildItem $Path -Recurse -Force -File | Where-Object {
        $_.Name -eq ".env" -or
        $_.Name -like "*.env.local" -or
        $_.Extension -in @(".db", ".sqlite3", ".part") -or
        $_.FullName -match "[\\/]benchmarks?[\\/]"
    }
    if ($forbidden) {
        $names = ($forbidden | ForEach-Object { $_.FullName }) -join "`n"
        throw "Forbidden development/private files found in release tree:`n$names"
    }
}

if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
    throw "Competition Release build must run on Windows 10/11 x64."
}
if (-not [Environment]::Is64BitOperatingSystem) {
    throw "Competition Release supports Windows x64 only."
}

Assert-Command "corepack"
Assert-Command "uv"

$VersionFile = Join-Path $RuntimeProject "src\xunlei_zhiqu_runtime\__init__.py"
$VersionText = Get-Content $VersionFile -Raw
if ($VersionText -notmatch '__version__\s*=\s*"([^"]+)"') {
    throw "Unable to read Runtime version from $VersionFile"
}
$Version = $Matches[1]
Write-Host "Building 迅雷智取 Competition Release $Version"

$GatewayBaseUrl = $GatewayBaseUrl.Trim().TrimEnd('/')
$GatewayModel = $GatewayModel.Trim()
$GatewayToken = $GatewayToken.Trim()

if ($GatewayBaseUrl -match '(?i)(api\.openai\.com|dashscope\.aliyuncs\.com|api\.anthropic\.com)') {
    throw "GatewayBaseUrl points at a model supplier endpoint. Competition Release requires a dedicated Competition Gateway."
}
if ($GatewayToken) {
    $localSupplierKey = Read-LocalSupplierKey
    if ($localSupplierKey -and $GatewayToken -eq $localSupplierKey) {
        throw "GatewayToken matches MODEL_API_KEY in local .env. Refusing to package a supplier credential."
    }
}
if (-not $GatewayBaseUrl) {
    if ($GatewayToken) {
        throw "GatewayToken was provided without GatewayBaseUrl."
    }
    Write-Warning "Competition Gateway is not configured. Packaging will complete, but AI zero-config release is not submission-ready."
}

Remove-Item $BuildRoot -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item $ReleaseDir -Recurse -Force -ErrorAction SilentlyContinue
New-Item $BuildRoot -ItemType Directory -Force | Out-Null
New-Item $ReleaseDir -ItemType Directory -Force | Out-Null

Invoke-Step "Python compile check" {
    & uv run --project $RuntimeProject python -m compileall (Join-Path $RuntimeProject "src")
}
Invoke-Step "Workspace typecheck" {
    Push-Location $RepoRoot
    try { & corepack pnpm typecheck } finally { Pop-Location }
}
Invoke-Step "Build Task Center" {
    Push-Location $RepoRoot
    try { & corepack pnpm --filter "@xunlei-zhiqu/task-center" build } finally { Pop-Location }
}
Invoke-Step "Build Extension" {
    Push-Location $RepoRoot
    try { & corepack pnpm --filter "@xunlei-zhiqu/extension" build } finally { Pop-Location }
}

if (-not (Test-Path (Join-Path $TaskCenterDist "index.html"))) {
    throw "Task Center build did not produce dist/index.html"
}
if (-not (Test-Path (Join-Path $ExtensionDist "manifest.json"))) {
    throw "Extension build did not produce dist/manifest.json"
}

$previousConsoleFlag = $env:XUNLEI_ZHIQU_CONSOLE_BUILD
try {
    $env:XUNLEI_ZHIQU_CONSOLE_BUILD = if ($ConsoleRuntime) { "1" } else { "0" }
    Invoke-Step "Build Runtime with PyInstaller onedir" {
        & uv run --project $RuntimeProject --with "pyinstaller>=6,<7" pyinstaller `
            --clean `
            --noconfirm `
            --distpath $PyInstallerDist `
            --workpath $PyInstallerWork `
            $SpecPath
    }
}
finally {
    $env:XUNLEI_ZHIQU_CONSOLE_BUILD = $previousConsoleFlag
}

$RuntimeExe = Join-Path $RuntimeDir "XunleiZhiqu.exe"
if (-not (Test-Path $RuntimeExe)) {
    throw "PyInstaller output is missing XunleiZhiqu.exe"
}

$ReleaseConfig = [ordered]@{
    schema_version = 1
    competition_gateway_configured = [bool]$GatewayBaseUrl
    gateway_base_url = $GatewayBaseUrl
    gateway_model = if ($GatewayBaseUrl) { $GatewayModel } else { "" }
    gateway_token = if ($GatewayBaseUrl) { $GatewayToken } else { "" }
    node_a_profile = "pipeline_v3"
}
$ReleaseConfigJson = $ReleaseConfig | ConvertTo-Json -Depth 4
[IO.File]::WriteAllText(
    (Join-Path $RuntimeDir "release-config.json"),
    $ReleaseConfigJson,
    $Utf8NoBom
)

Assert-ReleaseTree $RuntimeDir
Assert-ReleaseTree $ExtensionDist

$PortableRoot = Join-Path $PortableStage "XunleiZhiqu"
New-Item $PortableStage -ItemType Directory -Force | Out-Null
Copy-Item $RuntimeDir $PortableRoot -Recurse -Force

$PortableZip = Join-Path $ReleaseDir "XunleiZhiqu-Portable-x64.zip"
$ExtensionZip = Join-Path $ReleaseDir "XunleiZhiqu-Extension.zip"
Compress-Archive -Path $PortableRoot -DestinationPath $PortableZip -CompressionLevel Optimal
Compress-Archive -Path (Join-Path $ExtensionDist "*") -DestinationPath $ExtensionZip -CompressionLevel Optimal

$InstallerPath = Join-Path $ReleaseDir "XunleiZhiqu-Setup-x64.exe"
$Iscc = Find-InnoSetupCompiler
$InstallerBuilt = $false
if ($Iscc) {
    Invoke-Step "Build Inno Setup installer" {
        & $Iscc "/DSourceDir=$RuntimeDir" "/DOutputDir=$ReleaseDir" "/DAppVersion=$Version" $InnoScript
    }
    if (-not (Test-Path $InstallerPath)) {
        throw "Inno Setup completed but XunleiZhiqu-Setup-x64.exe was not found."
    }
    $InstallerBuilt = $true
}
else {
    Write-Warning "Portable 已构建完成；Installer 未生成：未找到 Inno Setup ISCC.exe。"
}

$ChecksumTargets = @()
if ($InstallerBuilt) { $ChecksumTargets += $InstallerPath }
$ChecksumTargets += $PortableZip
$ChecksumTargets += $ExtensionZip
$ChecksumLines = foreach ($target in $ChecksumTargets) {
    $hash = (Get-FileHash $target -Algorithm SHA256).Hash.ToLowerInvariant()
    "$hash  $([IO.Path]::GetFileName($target))"
}
$ChecksumPath = Join-Path $ReleaseDir "SHA256SUMS.txt"
[IO.File]::WriteAllLines($ChecksumPath, $ChecksumLines, $Utf8NoBom)

Write-Host ""
if ($InstallerBuilt) {
    Write-Host "Competition Release ready"
    Write-Host "Setup:     $InstallerPath"
} else {
    Write-Host "Competition Release packaging complete, installer pending Inno Setup"
    Write-Host "Setup:     NOT GENERATED"
}
Write-Host "Portable:  $PortableZip"
Write-Host "Extension: $ExtensionZip"
Write-Host "Checksums: $ChecksumPath"
Write-Host "Gateway:   $(if ($GatewayBaseUrl) { 'configured' } else { 'NOT configured' })"

if (-not $InstallerBuilt) {
    exit 2
}
