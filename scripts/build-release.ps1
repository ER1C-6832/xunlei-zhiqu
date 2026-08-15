param(
    [string]$GatewayBaseUrl = "",
    [string]$GatewayModel = "deepseek-v4-flash",
    [string]$GatewayToken = "",
    [switch]$EmbedLocalModelConfig,
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
    foreach ($version in @("7", "6")) {
        if (${env:ProgramFiles(x86)}) {
            $candidates += (Join-Path ${env:ProgramFiles(x86)} "Inno Setup $version\ISCC.exe")
        }
        if ($env:ProgramFiles) {
            $candidates += (Join-Path $env:ProgramFiles "Inno Setup $version\ISCC.exe")
        }
        if ($env:LOCALAPPDATA) {
            $candidates += (Join-Path $env:LOCALAPPDATA "Programs\Inno Setup $version\ISCC.exe")
        }
    }

    foreach ($candidate in $candidates) {
        if (Test-Path $candidate) {
            return $candidate
        }
    }
    return $null
}

function Read-DotEnvValue([string]$Path, [string]$Name) {
    if (-not (Test-Path $Path)) {
        return ""
    }
    $pattern = '^\s*' + [regex]::Escape($Name) + '\s*=\s*(.*)\s*$'
    foreach ($line in Get-Content $Path) {
        if ($line -match $pattern) {
            return $Matches[1].Trim().Trim('"').Trim("'")
        }
    }
    return ""
}

function Assert-ReleaseTree([string]$Path) {
    $forbidden = Get-ChildItem $Path -Recurse -Force -File | Where-Object {
        $_.Name -eq ".env" -or
        $_.Name -like ".env.*" -or
        $_.Extension -in @(".db", ".sqlite3", ".part") -or
        $_.FullName -match "[\\/]benchmarks?[\\/]"
    }
    if ($forbidden) {
        $names = ($forbidden | ForEach-Object { $_.FullName }) -join "`n"
        throw "Forbidden development/private files found in release tree:`n$names"
    }
}

function Assert-NoSensitiveFrontendText([string]$Path, [string[]]$Needles) {
    $textFiles = Get-ChildItem $Path -Recurse -Force -File | Where-Object {
        $_.Extension -in @(".js", ".mjs", ".cjs", ".json", ".html", ".css", ".txt")
    }
    foreach ($needle in $Needles) {
        if ([string]::IsNullOrWhiteSpace($needle) -or $needle.Length -lt 8) {
            continue
        }
        foreach ($file in $textFiles) {
            $text = [IO.File]::ReadAllText($file.FullName)
            if ($text.Contains($needle)) {
                throw "Sensitive/local development value leaked into frontend build: $($file.FullName)"
            }
        }
    }
}

function Save-ProcessEnv([string[]]$Names) {
    $snapshot = @{}
    foreach ($name in $Names) {
        $snapshot[$name] = [Environment]::GetEnvironmentVariable($name, "Process")
    }
    return $snapshot
}

function Restore-ProcessEnv([hashtable]$Snapshot) {
    foreach ($name in $Snapshot.Keys) {
        $value = $Snapshot[$name]
        if ($null -eq $value) {
            [Environment]::SetEnvironmentVariable($name, $null, "Process")
        }
        else {
            [Environment]::SetEnvironmentVariable($name, [string]$value, "Process")
        }
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

$RootEnv = Join-Path $RepoRoot ".env"
$GatewayBaseUrl = $GatewayBaseUrl.Trim().TrimEnd([char]'/')
$GatewayModel = $GatewayModel.Trim()
$GatewayToken = $GatewayToken.Trim()
$LocalModelProvider = Read-DotEnvValue $RootEnv "MODEL_PROVIDER"
$LocalModelBaseUrl = (Read-DotEnvValue $RootEnv "MODEL_BASE_URL").Trim().TrimEnd([char]'/')
$LocalModelName = Read-DotEnvValue $RootEnv "MODEL_NAME"
$LocalSupplierKey = Read-DotEnvValue $RootEnv "MODEL_API_KEY"
$LocalNodeAProfile = Read-DotEnvValue $RootEnv "NODE_A_PROFILE"
$LocalExtensionSession = Read-DotEnvValue (Join-Path $RepoRoot "apps\extension\.env") "VITE_RUNTIME_SESSION"
if (-not $LocalNodeAProfile) {
    $LocalNodeAProfile = "pipeline_v3"
}

if ($EmbedLocalModelConfig) {
    if ($GatewayBaseUrl -or $GatewayToken) {
        throw "EmbedLocalModelConfig cannot be combined with Competition Gateway parameters."
    }
    if ($LocalModelProvider -notin @("openai", "dashscope", "openai_compatible")) {
        throw "Root .env MODEL_PROVIDER must be openai, dashscope, or openai_compatible for -EmbedLocalModelConfig."
    }
    if (-not $LocalModelBaseUrl -or $LocalModelBaseUrl -notmatch '^https://') {
        throw "Root .env MODEL_BASE_URL must be a non-empty HTTPS URL for -EmbedLocalModelConfig."
    }
    if (-not $LocalModelName) {
        throw "Root .env MODEL_NAME is required for -EmbedLocalModelConfig."
    }
    if (-not $LocalSupplierKey) {
        throw "Root .env MODEL_API_KEY is required for -EmbedLocalModelConfig."
    }
    Write-Warning "Embedding the local supplier MODEL_API_KEY into this Competition Release. Anyone who receives the artifact can extract and use this credential."
}
else {
    if ($GatewayBaseUrl -and $GatewayBaseUrl -notmatch '^https://') {
        throw "GatewayBaseUrl must use HTTPS for a Competition Release."
    }
    if ($GatewayBaseUrl -match '(?i)(api\.openai\.com|dashscope\.aliyuncs\.com|api\.anthropic\.com)') {
        throw "GatewayBaseUrl points at a model supplier endpoint. Use -EmbedLocalModelConfig only when you intentionally accept embedding a supplier credential."
    }
    if ($GatewayBaseUrl -and -not $GatewayModel) {
        throw "GatewayModel is required when GatewayBaseUrl is configured."
    }
    if ($GatewayToken -and $LocalSupplierKey -and $GatewayToken -eq $LocalSupplierKey) {
        throw "GatewayToken matches MODEL_API_KEY in local .env. Use -EmbedLocalModelConfig only when supplier-key embedding is intentional."
    }
    if (-not $GatewayBaseUrl) {
        if ($GatewayToken) {
            throw "GatewayToken was provided without GatewayBaseUrl."
        }
        Write-Warning "Competition Gateway is not configured. Packaging will complete with AI disabled unless -EmbedLocalModelConfig is supplied."
    }
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

$frontendEnvNames = @(
    "VITE_RUNTIME_URL",
    "VITE_RUNTIME_SESSION",
    "VITE_ZHIQU_CAPABILITY_MODE",
    "VITE_ZHIQU_ANALYSIS_CREDENTIAL",
    "VITE_TASK_CENTER_FIXTURES"
)
$frontendEnv = Save-ProcessEnv $frontendEnvNames
try {
    $env:VITE_RUNTIME_URL = " "
    $env:VITE_RUNTIME_SESSION = " "
    $env:VITE_ZHIQU_CAPABILITY_MODE = "client_runtime"
    $env:VITE_ZHIQU_ANALYSIS_CREDENTIAL = "demo"
    $env:VITE_TASK_CENTER_FIXTURES = "false"

    Invoke-Step "Build Task Center" {
        Push-Location $RepoRoot
        try { & corepack pnpm --filter "@xunlei-zhiqu/task-center" build } finally { Pop-Location }
    }
    Invoke-Step "Build Extension" {
        Push-Location $RepoRoot
        try { & corepack pnpm --filter "@xunlei-zhiqu/extension" build } finally { Pop-Location }
    }
}
finally {
    Restore-ProcessEnv $frontendEnv
}

if (-not (Test-Path (Join-Path $TaskCenterDist "index.html"))) {
    throw "Task Center build did not produce dist/index.html"
}
if (-not (Test-Path (Join-Path $ExtensionDist "manifest.json"))) {
    throw "Extension build did not produce dist/manifest.json"
}
if (Test-Path (Join-Path $ExtensionDist "src")) {
    throw "Extension release unexpectedly contains src/."
}
if (Get-ChildItem $ExtensionDist -Recurse -File -Filter "*.map") {
    throw "Extension release unexpectedly contains source maps."
}

Assert-NoSensitiveFrontendText $TaskCenterDist @($RepoRoot, $LocalSupplierKey, $LocalExtensionSession)
Assert-NoSensitiveFrontendText $ExtensionDist @($RepoRoot, $LocalSupplierKey, $LocalExtensionSession)

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

$BundledExtensionDir = Join-Path $RuntimeDir "browser-extension"
New-Item $BundledExtensionDir -ItemType Directory -Force | Out-Null
Copy-Item (Join-Path $ExtensionDist "*") $BundledExtensionDir -Recurse -Force
if (-not (Test-Path (Join-Path $BundledExtensionDir "manifest.json"))) {
    throw "Bundled browser extension is missing manifest.json"
}

$AiMode = if ($EmbedLocalModelConfig) {
    "embedded_supplier"
}
elseif ($GatewayBaseUrl) {
    "gateway"
}
else {
    "unavailable"
}

$ReleaseConfig = [ordered]@{
    schema_version = 2
    ai_mode = $AiMode
    competition_gateway_configured = [bool]$GatewayBaseUrl
    gateway_base_url = $GatewayBaseUrl
    gateway_model = if ($GatewayBaseUrl) { $GatewayModel } else { "" }
    gateway_token = if ($GatewayBaseUrl) { $GatewayToken } else { "" }
    model_provider = if ($EmbedLocalModelConfig) { $LocalModelProvider } else { "" }
    model_base_url = if ($EmbedLocalModelConfig) { $LocalModelBaseUrl } else { "" }
    model_name = if ($EmbedLocalModelConfig) { $LocalModelName } else { "" }
    model_api_key = if ($EmbedLocalModelConfig) { $LocalSupplierKey } else { "" }
    node_a_profile = if ($EmbedLocalModelConfig) { $LocalNodeAProfile } else { "pipeline_v3" }
}
$ReleaseConfigJson = $ReleaseConfig | ConvertTo-Json -Depth 4
if (-not $EmbedLocalModelConfig -and $LocalSupplierKey -and $ReleaseConfigJson.Contains($LocalSupplierKey)) {
    throw "Supplier MODEL_API_KEY would leak into release-config.json without explicit opt-in."
}
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
Write-Host "AI mode:   $AiMode"
if ($EmbedLocalModelConfig) {
    Write-Warning "This Release contains an extractable supplier API key by explicit request."
}

if (-not $InstallerBuilt) {
    exit 2
}
