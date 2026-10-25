<#
  AutoChat 便携版构建脚本
  ========================
  把 node.exe + 应用源码 + 启动器 打成一个 ZIP，解压即开，无需安装 Node、无需联网即可打开配置器。
  模型（Ollama + 小模型）不在包里，由首启向导在配置时按需联网拉取。

  用法：
    powershell -ExecutionPolicy Bypass -File tools/build-portable.ps1
  可选参数：
    -NodeVersion 22.11.0   # 要与 package.json engines.node 匹配（>=18）
    -Arch x64
    -OutDir dist
    -OutName AutoChat-win-x64
#>
param(
  [string]$NodeVersion = '22.11.0',
  [string]$Arch = 'x64',
  [string]$OutDir = 'dist',
  [string]$OutName = 'AutoChat-win-x64'
)

$ErrorActionPreference = 'Stop'
$repo = Resolve-Path (Join-Path $PSScriptRoot '..')
$dist = Join-Path $repo $OutDir
New-Item -ItemType Directory -Force -Path $dist | Out-Null

$stage = Join-Path $env:TEMP ('autochat-portable-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $stage | Out-Null

try {
  # 1) node.exe：优先用 dist/node.exe（离线缓存），否则从官网下载
  $nodeExe = Join-Path $stage 'node.exe'
  $cached = Join-Path $dist 'node.exe'
  if (Test-Path $cached) {
    Copy-Item $cached $nodeExe
    Write-Host '使用已缓存的 node.exe'
  } else {
    $url = "https://nodejs.org/dist/v$NodeVersion/win-$Arch/node.exe"
    Write-Host "下载 Node.js $NodeVersion -> $url"
    try {
      Invoke-WebRequest -Uri $url -OutFile $nodeExe -UseBasicParsing
    } catch {
      throw "下载 node.exe 失败：$_ 请手动把对应版本的 node.exe 放到 $dist\node.exe 后重试（也可从 https://nodejs.org 下载 win-$Arch 版）。"
    }
  }

  # 2) 复制应用文件（对齐 package.json 的 files 字段）
  function CopyRel($rel) {
    $src = Join-Path $repo $rel
    if (-not (Test-Path $src)) { return }
    $dst = Join-Path $stage $rel
    New-Item -ItemType Directory -Force -Path (Split-Path $dst) | Out-Null
    Copy-Item $src $dst -Recurse -Force
  }
  CopyRel 'src'
  CopyRel 'test'
  CopyRel 'docs'

  # tools 只取白名单（顶层 *.js / *.bat / README.md），其余（第三方源码、*.py）不进包
  $toolsSrc = Join-Path $repo 'tools'
  $toolsDst = Join-Path $stage 'tools'
  New-Item -ItemType Directory -Force -Path $toolsDst | Out-Null
  foreach ($f in (Get-ChildItem $toolsSrc -File)) {
    if (@('.js', '.bat', '.md') -contains $f.Extension) {
      Copy-Item $f.FullName (Join-Path $toolsDst $f.Name) -Force
    }
  }

  # 顶层文件
  foreach ($f in @('package.json', 'package-lock.json', 'README.md', 'CHANGELOG.md', 'LEGAL.md', 'LICENSE', 'SECURITY.md', 'CONTRIBUTING.md', '.env.example', 'config.example.json')) {
    $src = Join-Path $repo $f
    if (Test-Path $src) { Copy-Item $src (Join-Path $stage $f) -Force }
  }

  # 3) 启动器 + 说明
  @'
@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
if not exist node.exe (
  echo [错误] 当前文件夹里找不到 node.exe。
  echo 这个 AutoChat.bat 必须和整个 AutoChat 文件夹放在一起使用，
  echo 不要把 AutoChat.bat 单独复制出来。请把整个 AutoChat 文件夹一起解压/移动。
  pause
  exit /b 1
)
if not exist src\cli\index.js (
  echo [错误] 当前文件夹里找不到 src 目录（应用本体缺失）。
  echo 请使用完整的 AutoChat 文件夹，不要只保留 AutoChat.bat。
  pause
  exit /b 1
)
echo 正在启动 AutoChat 配置器（浏览器会自动打开）……
node.exe src/cli/index.js gui
'@ | Set-Content -Encoding ascii (Join-Path $stage 'AutoChat.bat')

  @'
Set ws = CreateObject("WScript.Shell")
ws.Run "node.exe src/cli/index.js gui", 0, false
'@ | Set-Content -Encoding ascii (Join-Path $stage 'AutoChat-后台.vbs')

  @'
AutoChat 便携版 · 使用说明（小白版）
====================================

1. 把整个 AutoChat-win-x64 文件夹解压到电脑上任意位置
   （建议路径纯英文、不含空格，例如 D:\AutoChat）。

2. 双击 “AutoChat.bat”（想要没有黑色窗口就双击 “AutoChat-后台.vbs”）。
   - 第一次 Windows 可能弹出 SmartScreen“已保护你的电脑”，
     点“仍要运行”即可（这是开源工具，没人给它买代码签名证书）。

3. 浏览器会自动打开 “AutoChat 配置器”。跟着首启向导走：
   a. 装好并登录电脑版微信（这步必须你自己来，AutoChat 不能替你注册微信）。
   b. 点“注入 hook”（会弹 UAC 提权窗口，允许它）——把 AI 接到微信上。
   c. 选模型：推荐“本地模型(Ollama)”。本机没装 Ollama 的话，
      向导里点“下载并安装 Ollama”，会自动拉官方安装包并安装，
      再一键“启动模型服务”并拉一个小模型（几百 MB～1GB，请保持联网）。
   d. 点“启动助手”。之后微信里收到消息，AI 就会自动回复。

4. 想停：配置器里点“暂停自动回复”；彻底退出就关掉那个黑色窗口
   （或退出 AutoChat-后台.vbs 启动的 node 进程）。

常见问题
--------
- 配置器打不开？确认解压目录里有 node.exe 和 src 文件夹。
- 微信要自己先装好并登录；注入 hook 需要管理员权限。
- 本地模型第一次会下载几百 MB～1GB 的小模型，请保持联网。
'@ | Set-Content -Encoding utf8 (Join-Path $stage '使用说明.txt')

  # 4) 打包
  $zip = Join-Path $dist ($OutName + '.zip')
  if (Test-Path $zip) { Remove-Item $zip -Force }
  Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $zip -Force
  Write-Host "已生成：$zip"
  Write-Host ("大小：" + [math]::Round((Get-Item $zip).Length / 1MB, 1) + ' MB')
} finally {
  Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
}
