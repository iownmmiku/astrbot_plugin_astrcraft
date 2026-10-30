# 安装 Node 引擎依赖。
#
# 使用 npm ci 按发布包的锁文件安装：
# npm 默认把缓存与日志写到 %LOCALAPPDATA%\npm-cache，在受限环境（沙箱、企业策略、
# 只读用户目录）下会直接 EPERM 失败。这里把缓存显式指到项目内目录，绕开这个问题。
#
# 用法：powershell -ExecutionPolicy Bypass -File dev-tools\install.ps1

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$engineDir = Join-Path $repoRoot 'engine'
$cacheDir = Join-Path $repoRoot '_npm_cache'

Write-Host "=== 安装 Minecraft 引擎依赖 ===" -ForegroundColor Cyan
Write-Host "引擎目录: $engineDir"
Write-Host "npm 缓存: $cacheDir"
Write-Host ""

if (-not (Test-Path -LiteralPath $engineDir -PathType Container)) {
    Write-Host "找不到引擎目录：$engineDir" -ForegroundColor Red
    exit 1
}
foreach ($manifest in @('package.json', 'package-lock.json')) {
    if (-not (Test-Path -LiteralPath (Join-Path $engineDir $manifest) -PathType Leaf)) {
        Write-Host "引擎缺少 $manifest，请重新下载完整插件包。" -ForegroundColor Red
        exit 1
    }
}

# 锁定的 Mineflayer 版本要求 Node.js 22+；旧版本不能开始安装。
$node = Get-Command node -CommandType Application -ErrorAction SilentlyContinue
if (-not $node) {
    Write-Host "找不到 node。请先安装 Node.js 22+：https://nodejs.org/" -ForegroundColor Red
    exit 1
}
$nodeVersion = & $node.Source --version
if ($LASTEXITCODE -ne 0 -or $nodeVersion -notmatch '^v?(\d+)\.\d+\.\d+(?:[-+].*)?$') {
    Write-Host "无法读取 Node.js 版本，请检查 Node.js 22+ 安装。" -ForegroundColor Red
    exit 1
}
if ([int]$Matches[1] -lt 22) {
    Write-Host "当前 Node.js 为 $nodeVersion，需要 Node.js 22+：https://nodejs.org/" -ForegroundColor Red
    exit 1
}
# 直接调用 npm.cmd，避开 npm.ps1 的执行策略，同时保持目录参数的独立引用。
$npm = Get-Command npm.cmd -CommandType Application -ErrorAction SilentlyContinue
if (-not $npm) {
    Write-Host "找不到 npm.cmd，请检查 Node.js 与 npm 是否已加入 PATH。" -ForegroundColor Red
    exit 1
}
Write-Host "Node.js: $nodeVersion"
Write-Host ""

New-Item -ItemType Directory -Force -Path $cacheDir | Out-Null

Push-Location -LiteralPath $engineDir
try {
    & $npm.Source ci --cache $cacheDir --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) {
        Write-Host ""
        Write-Host "npm ci 失败（退出码 $LASTEXITCODE）" -ForegroundColor Red
        Write-Host "可以尝试：" -ForegroundColor Yellow
        Write-Host "  在 engine 目录检查 npm 输出，重试：npm.cmd ci --cache D:\npm-cache"
        exit 1
    }
} finally {
    Pop-Location
}

# 校验关键依赖真的装上了
$required = @('canvas', 'mineflayer', 'minecraft-data', 'mineflayer-pathfinder')
$missing = @()
foreach ($pkg in $required) {
    $p = Join-Path $engineDir "node_modules\$pkg\package.json"
    if (Test-Path -LiteralPath $p -PathType Leaf) {
        $ver = (Get-Content -LiteralPath $p -Raw | ConvertFrom-Json).version
        Write-Host ("  [OK] {0}@{1}" -f $pkg, $ver) -ForegroundColor Green
    } else {
        $missing += $pkg
        Write-Host ("  [缺失] {0}" -f $pkg) -ForegroundColor Red
    }
}

if ($missing.Count -gt 0) {
    Write-Host ""
    Write-Host "以下依赖没有装上：$($missing -join ', ')" -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host "依赖安装完成。下一步自检：" -ForegroundColor Cyan
Write-Host "  node `"$(Join-Path $repoRoot 'dev-tools\smoke.js')`""
