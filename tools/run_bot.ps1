param(
    [string]$Chat = '59074288439@chatroom',
    [switch]$DryRun,
    [double]$Interval = 1.5
)

$ErrorActionPreference = 'Continue'
$root = 'c:\Users\yushi\CodeBuddy\SnowLuma-wx'
Set-Location $root
$env:PYTHONIOENCODING = 'utf-8'

Write-Output '=== 1. 微信 hook ==='
$st = curl.exe -s --max-time 5 http://127.0.0.1:30001/QueryDB/status 2>&1
if ($LASTEXITCODE -ne 0 -or -not $st) {
    Write-Output '[ERR] 127.0.0.1:30001 不通：确认微信在跑，D:\Weixin\version.dll 是自编译版'
    exit 1
}
Write-Output $st

Write-Output ''
Write-Output '=== 2. 数据库可读性 ==='
$db = curl.exe -s --max-time 10 -X POST http://127.0.0.1:30001/QueryDB/GetAllDBName `
    -H 'Content-Type: application/json' -d '{}' 2>&1 | Out-String
if ($db -notmatch 'message_0\.db') {
    Write-Output '[ERR] 拿不到数据库句柄，检查 deployed DLL 是否去掉了 g_IsLogin 判断'
    Write-Output $db.Substring(0, [Math]::Min(200, $db.Length))
    exit 1
}
Write-Output 'OK：message_0.db / contact.db 可访问'

Write-Output ''
Write-Output '=== 3. 本地模型 ==='
$c = Get-NetTCPConnection -LocalPort 11434 -State Listen -ErrorAction SilentlyContinue
if (-not $c) {
    $exe = "$env:LOCALAPPDATA\Programs\Ollama\ollama.exe"
    if (-not (Test-Path $exe)) { Write-Output '[ERR] ollama 未安装'; exit 1 }
    Write-Output '启动 ollama serve…'
    Start-Process -FilePath $exe -ArgumentList 'serve' -WindowStyle Hidden
    Start-Sleep -Seconds 6
}
$tags = curl.exe -s --max-time 8 http://127.0.0.1:11434/api/tags 2>&1 | Out-String
if ($tags -notmatch 'qwen2\.5:1\.5b') { Write-Output '[WARN] 缺 qwen2.5:1.5b，先 ollama pull' }
if ($tags -notmatch 'coder:7b') { Write-Output '[WARN] 缺 qwen2.5-coder:7b，写代码功能不可用' }
Write-Output 'OK'

Write-Output ''
Write-Output '=== 4. 停旧进程 ==='
Get-CimInstance Win32_Process -Filter "Name='python.exe'" |
    Where-Object { $_.CommandLine -match 'bot_db|watch_reply|collect\.py' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; "  停掉 $($_.ProcessId)" }

Write-Output ''
Write-Output '=== 5. 启动 ==='
$pyArgs = @(
    'tools/bot_db.py', '--chat', $Chat, '--interval', "$Interval", '--seconds', '0',
    '--ai-model', 'qwen2.5:7b',            # 聊天：7B 比 1.5B 自然得多
    '--intent-model', 'qwen2.5-coder:7b',  # 把关
    '--task-model', 'qwen2.5-coder:7b',    # 写代码
    '--context', '6',
    '--persona', 'data/persona.md'
)
if (-not $DryRun) { $pyArgs += '--send' } else { $pyArgs += '--dry' }

Remove-Item botdb.out, botdb.err -Force -ErrorAction SilentlyContinue
Start-Process -FilePath (Get-Command python).Source -ArgumentList $pyArgs -WorkingDirectory $root `
    -RedirectStandardOutput 'botdb.out' -RedirectStandardError 'botdb.err' -WindowStyle Hidden

Start-Sleep -Seconds 6
Get-Content botdb.out -Encoding UTF8 -ErrorAction SilentlyContinue | Select-Object -First 10
Write-Output ''
Write-Output '实时日志： Get-Content botdb.out -Tail 20 -Wait'
