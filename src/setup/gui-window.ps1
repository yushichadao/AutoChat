param(
  [Parameter(Mandatory = $true)][string]$Url
)

# AutoChat 图形化配置器的桌面窗口。
# 不用 WebBrowser 控件（IE 内核跑不了现代 JS），
# 改用 Edge 的 --app 模式：没有地址栏，就是一个独立窗口。
# 找不到 Edge 就退回默认浏览器。

$paths = @(
  ($env:ProgramFiles + "/Microsoft/Edge/Application/msedge.exe"),
  ($env:LOCALAPPDATA + "/Microsoft/Edge/Application/msedge.exe")
)
$edge = $paths | Where-Object { Test-Path $_ } | Select-Object -First 1

if ($edge) {
  Start-Process -FilePath $edge -ArgumentList "--app=$Url", "--window-size=1180,900"
} else {
  Start-Process $Url
}
