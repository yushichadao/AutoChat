@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0.."

echo.
echo === AutoChat 首次运行 ===
echo.

node -v
if errorlevel 1 goto nonode

echo.
echo [1/3] 环境体检（缺什么会直接告诉你）
node src/cli/index.js doctor

echo.
echo [2/3] 打开图形化配置器
node src/cli/index.js gui

echo.
echo 想跑初始化向导？在项目目录里执行：npm run setup
echo.
pause
exit /b 0

:nonode
echo 没有找到 Node.js。
echo 请先安装 18 以上版本（推荐 22 LTS）：https://nodejs.org/zh-cn/download
echo.
pause
exit /b 1
