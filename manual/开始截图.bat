@echo off
REM cx-cli 自动化截图启动器
REM 双击此文件即可启动截图脚本

echo ========================================
echo   cx-cli 自动化截图工具
echo ========================================
echo.

REM 检查 PowerShell 版本
powershell -Command "$PSVersionTable.PSVersion" | findstr /C:"Major" >nul
if errorlevel 1 (
    echo [错误] PowerShell 未安装或版本过低
    echo 请安装 PowerShell 5.1 或更高版本
    echo.
    pause
    exit /b 1
)

echo [1/3] 检查脚本文件...
if not exist "capture-screenshots-v2.ps1" (
    echo [错误] 找不到 capture-screenshots-v2.ps1
    echo 请确保此 BAT 文件和脚本在同一目录
    echo.
    pause
    exit /b 1
)
echo [OK] 脚本文件存在

echo.
echo [2/3] 检查 images 目录...
if not exist "images" (
    mkdir images
    echo [OK] 已创建 images 目录
) else (
    echo [OK] images 目录已存在
)

echo.
echo [3/3] 启动截图脚本...
echo.

REM 设置执行策略（当前进程）
powershell -ExecutionPolicy Bypass -File "capture-screenshots-v2.ps1"

if errorlevel 1 (
    echo.
    echo [错误] 脚本执行失败
    echo 请查看上方的错误信息
    echo.
    pause
    exit /b 1
)

echo.
echo ========================================
echo   截图完成！
echo ========================================
echo.
echo 下一步:
echo   1. 打开 cx-cli\manual\index.html 验证截图
echo   2. 按 F5 刷新浏览器
echo   3. 手动添加架构图: images\placeholder-architecture.png
echo.
pause
