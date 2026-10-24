$ErrorActionPreference = 'Continue'
$url = 'https://ghfast.top/https://github.com/brechtsanders/winlibs_mingw/releases/download/16.2.0posix-23.1.3-14.0.0-ucrt-r3/winlibs-x86_64-posix-seh-gcc-16.2.0-mingw-w64ucrt-14.0.0-r3.zip'
$out = Join-Path $PSScriptRoot 'mingw64-new.zip'
$err = Join-Path $PSScriptRoot 'mingw-download.err'

if (Test-Path $out) { Remove-Item $out -Force -ErrorAction SilentlyContinue }
if (Test-Path $err) { Remove-Item $err -Force -ErrorAction SilentlyContinue }

Write-Output "saving to $out"
Start-Process -FilePath 'curl.exe' -ArgumentList @('-L', '--max-time', '900', '-o', $out, $url) -RedirectStandardError $err -WindowStyle Hidden

Start-Sleep -Seconds 30
if (Test-Path $out) {
    $mb = [math]::Round((Get-Item $out).Length / 1MB, 1)
    Write-Output "downloaded $mb MB"
} else {
    Write-Output 'not written yet, errors:'
    Get-Content $err -ErrorAction SilentlyContinue | Select-Object -First 5
}
