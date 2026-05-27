# cx-cli 自动化截图脚本 v2.0
#
# 使用方法：
# 1. 编辑脚本开头的配置区（PAT_TOKEN 和 QUERY_YEAR）
# 2. 右键点击 → 使用 PowerShell 运行
# 3. 或在 PowerShell 中运行：.\capture-screenshots-v2.ps1
#
# 前置条件：
# - 已安装 cx-windows.exe 并添加到 PATH
# - 已准备好有效的 PAT token
# - Windows 10/11（使用内置截图工具）

# ==================== 配置区（⚠️ 必填）====================

# 配置你的 PAT token（必填）
$PAT_TOKEN = "cx_pat_xxx.yyy"  # ⚠️ 替换为你的真实 token

# 查询参数配置
$QUERY_YEAR = "2026"  # 根据实际数据修改年份

# 截图保存目录
$OUTPUT_DIR = "images"

# 截图延迟（秒），等待命令执行完成
$DELAY_SECONDS = 3

# ==================== 初始化 ====================

Clear-Host
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  cx-cli 自动化截图脚本 v2.0" -ForegroundColor Cyan
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
    $versionCheck = & cx --version 2>&1
    if ($LASTEXITCODE -eq 0) {
        Write-Host "✓ cx 版本: $versionCheck" -ForegroundColor Green
    } else {
        throw "cx 命令执行失败"
    }
} catch {
    Write-Host "✗ 错误: cx 命令不可用" -ForegroundColor Red
    Write-Host "  请检查:" -ForegroundColor Yellow
    Write-Host "    1. cx-windows.exe 是否在 C:\tools\cx\ 目录" -ForegroundColor Yellow
    Write-Host "    2. C:\tools\cx\ 是否已添加到系统 PATH" -ForegroundColor Yellow
    Write-Host "    3. 是否已重启命令行窗口" -ForegroundColor Yellow
    Read-Host "`n按回车键退出"
    exit 1
}

Write-Host ""

# 检查 PAT_TOKEN 是否已配置
if ($PAT_TOKEN -eq "cx_pat_xxx.yyy") {
    Write-Host "✗ 警告: PAT_TOKEN 未配置" -ForegroundColor Red
    Write-Host "  请编辑脚本第 18 行，替换为你的真实 token" -ForegroundColor Yellow
    Read-Host "`n按回车键退出"
    exit 1
}

# ==================== 截图函数 ====================

function Take-Screenshot {
    param(
        [string]$FileName
    )

    $fullPath = Join-Path $OUTPUT_DIR $FileName

    # 使用 PowerShell 截屏方法（兼容性最好）
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing

    # 获取主屏幕尺寸
    $screenBounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds

    # 创建位图
    $bitmap = New-Object System.Drawing.Bitmap($screenBounds.Width, $screenBounds.Height)

    # 从屏幕复制图像
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $graphics.CopyFromScreen($screenBounds.Location, [System.Drawing.Point]::Empty, $screenBounds.Size)

    # 保存为 PNG
    $bitmap.Save($fullPath, [System.Drawing.Imaging.ImageFormat]::Png)

    # 释放资源
    $graphics.Dispose()
    $bitmap.Dispose()

    Write-Host "  ✓ 已保存: $FileName" -ForegroundColor Green
}

# ==================== 命令执行函数 ====================

function Invoke-CxScreenshot {
    param(
        [string]$Command,
        [string]$FileName,
        [string]$Title,
        [string]$Prompt
    )

    Write-Host "`n----------------------------------------" -ForegroundColor Gray
    Write-Host "▶ $Title" -ForegroundColor Cyan
    Write-Host "  命令: $Command" -ForegroundColor Gray

    if ($Prompt) {
        Write-Host "  $Prompt" -ForegroundColor Yellow
    }

    # 询问用户是否准备好
    Write-Host "`n  准备好后按回车键继续..." -ForegroundColor Gray
    Read-Host

    # 清空屏幕（可选，让截图更干净）
    # Clear-Host

    # 显示提示信息
    Write-Host "`n========================================" -ForegroundColor Gray
    Write-Host "  cx-cli 截图中..." -ForegroundColor Gray
    Write-Host "========================================" -ForegroundColor Gray

    # 执行命令
    Write-Host "`nPS> $Command" -ForegroundColor White
    $output = Invoke-Expression $Command 2>&1

    if ($output) {
        Write-Host "$output" -ForegroundColor White
    }

    # 等待输出稳定
    Write-Host "`n⏳ 等待 $DELAY_SECONDS 秒后截图..." -ForegroundColor Yellow
    Start-Sleep -Seconds $DELAY_SECONDS

    # 截图
    Take-Screenshot -FileName $FileName
}

# ==================== 清理旧文件 ====================

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "准备开始截图" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan

$existingFiles = Get-ChildItem -Path $OUTPUT_DIR -Filter "*.png" -ErrorAction SilentlyContinue
if ($existingFiles) {
    Write-Host "`n发现旧截图文件:" -ForegroundColor Yellow
    $existingFiles | ForEach-Object { Write-Host "  - $($_.Name)" -ForegroundColor Gray }

    Write-Host "`n是否删除旧文件？(Y/N)" -ForegroundColor Yellow
    $confirm = Read-Host

    if ($confirm -eq 'Y' -or $confirm -eq 'y') {
        $existingFiles | ForEach-Object { Remove-Item $_.FullName }
        Write-Host "✓ 已删除旧文件" -ForegroundColor Green
    } else {
        Write-Host "ℹ 保留旧文件" -ForegroundColor Yellow
    }
} else {
    Write-Host "`n✓ images 目录为空，可以开始截图" -ForegroundColor Green
}

# ==================== 截图清单 ====================

Write-Host "`n========================================" -ForegroundColor Cyan
Write-Host "截图清单（共 10 张）" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan

Write-Host "`n提示:" -ForegroundColor Yellow
Write-Host "  - 确保命令行窗口在前台" -ForegroundColor White
Write-Host "  - 推荐使用 PowerShell 深色主题" -ForegroundColor White
Write-Host "  - 窗口大小建议 1400×900 或更大" -ForegroundColor White
Write-Host "  - 按 Ctrl+C 可随时中断" -ForegroundColor White

Read-Host "`n按回车键开始截图"

# ==================== 执行截图 ====================

# 01. 版本验证
Invoke-CxScreenshot -Command "cx --version" `
    -FileName "03-version-check.png" `
    -Title "01/10 版本验证" `
    -Prompt "确认 cx 命令可用"

# 02. 登录
Invoke-CxScreenshot -Command "cx login --token $PAT_TOKEN" `
    -FileName "04-login-cmd.png" `
    -Title "02/10 登录" `
    -Prompt "将使用你配置的 PAT token"

# 03. 查看身份
Invoke-CxScreenshot -Command "cx whoami" `
    -FileName "04-whoami-output.png" `
    -Title "03/10 查看身份" `
    -Prompt "将显示当前用户信息"

# 04. 查看路由
Invoke-CxScreenshot -Command "cx routes" `
    -FileName "05-cx-routes.png" `
    -Title "04/10 查看路由" `
    -Prompt "将显示所有可用查询路由"

# 05. 查询 KPI
Invoke-CxScreenshot -Command "cx query KPI --year=$QUERY_YEAR" `
    -FileName "05-cx-query.png" `
    -Title "05/10 查询 KPI" `
    -Prompt "年份: $QUERY_YEAR（如无数据请修改配置）"

# 06. 查看字段
Invoke-CxScreenshot -Command "cx fields" `
    -FileName "05-cx-fields.png" `
    -Title "06/10 查看字段" `
    -Prompt "将显示 42 个字段的注册表"

# 07. 查看指标
Invoke-CxScreenshot -Command "cx metrics" `
    -FileName "05-cx-metrics.png" `
    -Title "07/10 查看指标" `
    -Prompt "将显示 25 个指标的注册表"

# 08. 查看预设
Invoke-CxScreenshot -Command "cx presets" `
    -FileName "05-cx-presets.png" `
    -Title "08/10 查看预设" `
    -Prompt "将显示筛选器预设"

# 09. SQL 查询
$sqlQuery = "SELECT 三级机构, SUM(保费) AS 总保费 FROM PolicyFact WHERE year=$QUERY_YEAR GROUP BY 1"
Invoke-CxScreenshot -Command "cx sql `"$sqlQuery`"" `
    -FileName "06-cx-sql.png" `
    -Title "09/10 SQL 查询" `
    -Prompt "将执行 DuckDB 聚合查询"

# 10. 再次验证（备用）
Invoke-CxScreenshot -Command "cx --version" `
    -FileName "03-version-check-alt.png" `
    -Title "10/10 版本验证（备用）" `
    -Prompt "备用截图"

# ==================== 完成报告 ====================

Clear-Host
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "✓ 截图完成！" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Cyan

# 统计
$screenshotFiles = Get-ChildItem -Path $OUTPUT_DIR -Filter "*.png"
$totalSize = ($screenshotFiles | Measure-Object -Property Length -Sum).Sum / 1MB

Write-Host "`n📊 统计信息:" -ForegroundColor Yellow
Write-Host "  文件数: $($screenshotFiles.Count) 张" -ForegroundColor White
Write-Host "  总大小: $([math]::Round($totalSize, 2)) MB" -ForegroundColor White
Write-Host "  目录: $((Resolve-Path $OUTPUT_DIR).Path)" -ForegroundColor White

# 检查清单
Write-Host "`n✅ 检查清单:" -ForegroundColor Yellow

$requiredFiles = @(
    @{File="03-version-check.png"; Desc="版本验证"},
    @{File="04-login-cmd.png"; Desc="登录命令"},
    @{File="04-whoami-output.png"; Desc="查看身份"},
    @{File="05-cx-routes.png"; Desc="查看路由"},
    @{File="05-cx-query.png"; Desc="查询 KPI"},
    @{File="05-cx-fields.png"; Desc="查看字段"},
    @{File="05-cx-metrics.png"; Desc="查看指标"},
    @{File="05-cx-presets.png"; Desc="查看预设"},
    @{File="06-cx-sql.png"; Desc="SQL 查询"}
)

$missingFiles = @()
foreach ($item in $requiredFiles) {
    $filePath = Join-Path $OUTPUT_DIR $item.File
    if (Test-Path $filePath) {
        $fileSize = (Get-Item $filePath).Length / 1KB
        Write-Host "  ✓ $($item.Desc) ($($item.File)) - $([math]::Round($fileSize, 1)) KB" -ForegroundColor Green
    } else {
        Write-Host "  ✗ $($item.Desc) ($($item.File)) - 缺失" -ForegroundColor Red
        $missingFiles += $item.File
    }
}

# 下一步
Write-Host "`n📋 下一步操作:" -ForegroundColor Yellow

if ($missingFiles.Count -eq 0) {
    Write-Host "  1. 打开 cx-cli\manual\index.html 验证截图效果" -ForegroundColor White
    Write-Host "  2. 按 F5 刷新浏览器查看" -ForegroundColor White
    Write-Host "  3. 如需调整，手动编辑 images 目录下的文件" -ForegroundColor White
    Write-Host "  4. 手动添加架构图: images\placeholder-architecture.png" -ForegroundColor White
    Write-Host "`n  导出 PDF: 浏览器中按 Ctrl+P → 另存为 PDF" -ForegroundColor White
} else {
    Write-Host "  1. 缺失的文件需要手动截图补充" -ForegroundColor White
    Write-Host "  2. 参考 '截图指南.md' 重新截图" -ForegroundColor White
    Write-Host "  3. 或重新运行本脚本" -ForegroundColor White
}

Write-Host "`n按回车键退出..." -ForegroundColor Gray
Read-Host
