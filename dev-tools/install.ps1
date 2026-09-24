# 安装 Node 引擎依赖。
#
# 为什么不用普通的 npm install：
# npm 默认把缓存与日志写到 %LOCALAPPDATA%\npm-cache，在受限环境（沙箱、企业策略、
# 只读用户目录）下会直接 EPERM 失败。这里把缓存显式指到项目内目录，绕开这个问题。
#
# 用法：powershell -ExecutionPolicy Bypass -File scripts\install.ps1

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$botDir = Join-Path $repoRoot 'bot'
$cacheDir = Join-Path $repoRoot '_npm_cache'

Write-Host "=== 安装 Minecraft 引擎依赖 ===" -ForegroundColor Cyan
Write-Host "引擎目录: $botDir"
Write-Host "npm 缓存: $cacheDir"
Write-Host ""

if (-not (Test-Path $botDir)) {
    Write-Host "找不到引擎目录：$botDir" -ForegroundColor Red
    exit 1
}

# 确认 node 可用
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
    Write-Host "找不到 node。请先安装 Node.js 18+：https://nodejs.org/" -ForegroundColor Red
    exit 1
}
Write-Host "Node.js: $(& node --version)"
Write-Host ""

New-Item -ItemType Directory -Force -Path $cacheDir | Out-Null

Push-Location $botDir
try {
    # npm 在 PowerShell 里是 npm.ps1，可能被 ExecutionPolicy 拦住，所以走 cmd
    & cmd /c "npm install --cache `"$cacheDir`" --no-audit --no-fund 2>&1"
    if ($LASTEXITCODE -ne 0) {
        Write-Host ""
        Write-Host "npm install 失败（退出码 $LASTEXITCODE）" -ForegroundColor Red
        Write-Host "可以尝试：" -ForegroundColor Yellow
        Write-Host "  1) 换一个缓存目录：npm install --cache D:\npm-cache"
        Write-Host "  2) 换镜像源：npm install --registry https://registry.npmmirror.com"
        exit 1
    }
} finally {
    Pop-Location
}

# 校验关键依赖真的装上了
$required = @('mineflayer', 'minecraft-data', 'mineflayer-pathfinder')
$missing = @()
foreach ($pkg in $required) {
    $p = Join-Path $botDir "node_modules\$pkg\package.json"
    if (Test-Path $p) {
        $ver = (Get-Content $p -Raw | ConvertFrom-Json).version
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
Write-Host "  cd bot"
Write-Host "  node tools/smoke.js"
