# cx-cli 自动化截图脚本
#
# 使用方法：
# 1. 右键点击此文件 → 使用 PowerShell 运行
# 2. 或在 PowerShell 中运行：.\capture-screenshots.ps1
#
# 前置条件：
# - 已安装 cx-windows.exe 并添加到 PATH
# - 已准备好有效的 PAT token

# ==================== 配置区 ====================

# 配置你的 PAT token（必填）
$PAT_TOKEN = "cx_pat_xxx.yyy"  # ⚠️ 替换为你的真实 token

# 查询参数配置
$QUERY_YEAR = "2026"  # 根据实际数据修改

# 截图保存目录
$OUTPUT_DIR = "images"

# 命令行窗口配置
$WINDOW_WIDTH = 1400
$WINDOW_HEIGHT = 900

# 截图延迟（秒），等待命令执行完成
$DELAY_SECONDS = 2

# ==================== 初始化 ====================

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  cx-cli 自动化截图脚本" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# 创建输出目录
if (-not (Test-Path $OUTPUT_DIR)) {
    New-Item -ItemType Directory -Path $OUTPUT_DIR | Out-Null
    Write-Host "✓ 创建输出目录: $OUTPUT_DIR" -ForegroundColor Green
}

# 检查 cx 命令是否可用
Write-Host "检查 cx 命令..." -ForegroundColor Yellow
try {
    $versionOutput = & cx --version 2>&1
    if ($LASTEXITCODE -eq 0) {
        Write-Host "✓ cx 版本: $versionOutput" -ForegroundColor Green
    } else {
        throw "cx 命令不可用"
    }
} catch {
    Write-Host "✗ 错误: cx 命令不可用，请检查 PATH 配置" -ForegroundColor Red
    Write-Host "  提示: 将 C:\tools\cx\ 添加到系统 PATH 后重启命令行窗口" -ForegroundColor Yellow
    Read-Host "按回车键退出"
    exit 1
}

Write-Host ""

# ==================== 截图函数 ====================

function Take-Screenshot {
    param(
        [string]$FilePath,
        [int]$Width = $WINDOW_WIDTH,
        [int]$Height = $WINDOW_HEIGHT
    )

    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing

    # 创建截图
    $bounds = [System.Drawing.Rectangle]::FromLTRB(0, 0, Get-SystemMetrics(0), Get-SystemMetrics(1))
    $bitmap = New-Object System.Drawing.Bitmap($bounds.Width, $bounds.Height)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $graphics.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)

    # 保存为 PNG
    $bitmap.Save($FilePath, [System.Drawing.Imaging.ImageFormat]::Png)
    $graphics.Dispose()
    $bitmap.Dispose()

    Write-Host "  → 截图已保存: $FilePath" -ForegroundColor Gray
}

if (-not ("User32" -as [type])) {
    Add-Type -Name User32 -MemberDefinition @"
        [DllImport("user32.dll")]
        public static extern int GetSystemMetrics(int nIndex);
"@ -Namespace Win32
}

# ==================== 执行命令并截图 ====================

function Invoke-CxCommand {
    param(
        [string]$Command,
        [string]$ScreenshotFile,
        [string]$Description
    )

    Write-Host "`n▶ $Description" -ForegroundColor Cyan
    Write-Host "  命令: $Command" -ForegroundColor Gray

    # 执行命令
    $output = Invoke-Expression $command 2>&1
    if ($output) {
        Write-Host "  输出: $($output -join '`n')" -ForegroundColor White
    }

    # 等待
    Start-Sleep -Seconds $DELAY_SECONDS

    # 截图
    $fullPath = Join-Path $OUTPUT_DIR $ScreenshotFile
    Take-Screenshot -FilePath $fullPath

    Write-Host "  ✓ 完成" -ForegroundColor Green
}

# ==================== 清理旧截图 ====================

Write-Host "清理旧截图..." -ForegroundColor Yellow
Get-ChildItem -Path $OUTPUT_DIR -Filter "*.png" -ErrorAction SilentlyContinue | ForEach-Object {
    Remove-Item $_.FullName
    Write-Host "  删除: $($_.Name)" -ForegroundColor Gray
}
Write-Host "✓ 清理完成" -ForegroundColor Green

# ==================== 开始截图 ====================

Write-Host "`n========================================" -ForegroundColor Cyan
Write-Host "开始自动截图（共 10 张）" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan

# 截图 01: 版本验证
Invoke-CxCommand -Command "cx --version" `
    -ScreenshotFile "03-version-check.png" `
    -Description "01/10 版本验证"

# 截图 02: 登录
Invoke-CxCommand -Command "cx login --token $PAT_TOKEN" `
    -ScreenshotFile "04-login-cmd.png" `
    -Description "02/10 登录"

# 截图 03: whoami
Invoke-CxCommand -Command "cx whoami" `
    -ScreenshotFile "04-whoami-output.png" `
    -Description "03/10 查看身份"

# 截图 04: routes
Invoke-CxCommand -Command "cx routes" `
    -ScreenshotFile "05-cx-routes.png" `
    -Description "04/10 查看路由"

# 截图 05: query KPI
Invoke-CxCommand -Command "cx query KPI --year=$QUERY_YEAR" `
    -ScreenshotFile "05-cx-query.png" `
    -Description "05/10 查询 KPI"

# 截图 06: fields
Invoke-CxCommand -Command "cx fields" `
    -ScreenshotFile "05-cx-fields.png" `
    -Description "06/10 查看字段"

# 截图 07: metrics
Invoke-CxCommand -Command "cx metrics" `
    -ScreenshotFile "05-cx-metrics.png" `
    -Description "07/10 查看指标"

# 截图 08: presets
Invoke-CxCommand -Command "cx presets" `
    -ScreenshotFile "05-cx-presets.png" `
    -Description "08/10 查看预设"

# 截图 09: sql query
$sqlCommand = 'cx sql "SELECT 三级机构, SUM(保费) AS 总保费 FROM PolicyFact WHERE year=' + $QUERY_YEAR + ' GROUP BY 1"'
Invoke-CxCommand -Command $sqlCommand `
    -ScreenshotFile "06-cx-sql.png" `
    -Description "09/10 SQL 查询"

# 截图 10: version 再次验证（备用）
Invoke-CxCommand -Command "cx --version" `
    -ScreenshotFile "03-version-check-alt.png" `
    -Description "10/10 版本验证（备用）"

# ==================== 完成 ====================

Write-Host "`n========================================" -ForegroundColor Cyan
Write-Host "✓ 所有截图完成！" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Cyan

# 统计
$screenshotCount = (Get-ChildItem -Path $OUTPUT_DIR -Filter "*.png").Count
Write-Host "`n截图统计:" -ForegroundColor Yellow
Write-Host "  总计: $screenshotCount 张" -ForegroundColor White
Write-Host "  位置: $((Resolve-Path $OUTPUT_DIR).Path)" -ForegroundColor White

# 检查清单
Write-Host "`n检查清单:" -ForegroundColor Yellow
$checklist = @(
    "03-version-check.png",
    "04-login-cmd.png",
    "04-whoami-output.png",
    "05-cx-routes.png",
    "05-cx-query.png",
    "05-cx-fields.png",
    "05-cx-metrics.png",
    "05-cx-presets.png",
    "06-cx-sql.png"
)

foreach ($file in $checklist) {
    $filePath = Join-Path $OUTPUT_DIR $file
    if (Test-Path $filePath) {
        Write-Host "  ✓ $file" -ForegroundColor Green
    } else {
        Write-Host "  ✗ $file (缺失)" -ForegroundColor Red
    }
}

Write-Host "`n下一步:" -ForegroundColor Yellow
Write-Host "  1. 打开 cx-cli\manual\index.html 验证截图" -ForegroundColor White
Write-Host "  2. 手动补充架构图: images\placeholder-architecture.png" -ForegroundColor White
Write-Host "  3. 按 F5 刷新浏览器查看效果" -ForegroundColor White

Write-Host "`n按回车键退出..." -ForegroundColor Gray
Read-Host
