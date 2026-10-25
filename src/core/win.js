import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

/**
 * Windows 小工具：注册表自启、桌面快捷方式、进程管理。
 * 全部走系统自带的 PowerShell / reg.exe，不引入任何原生依赖。
 */
export const isWindows = process.platform === 'win32';

export function ps(script, timeout = 60000) {
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true, timeout, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) =>
        resolve({ ok: !err, out: String(stdout || '').trim(), err: String(stderr || '').trim() })
    );
  });
}

const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';

/**
 * 通过 WMI 创建进程。
 *
 * 为什么要它：普通 spawn / Start-Process 拉起来的后台进程，是调用方的子进程，
 * 关掉终端窗口、或调用方所在的「进程作业」被回收时，它会被一起带走 ——
 * 表现就是「服务莫名其妙自己没了」。
 * WMI 创建的进程归 WMI provider 管，不在调用方的作业里，因此能一直活着。
 *
 * @param {string} commandLine 完整的命令行
 * @returns {Promise<{ok:boolean, pid:number, message:string}>}
 */
export async function wmiCreate(commandLine) {
  if (!isWindows) return { ok: false, pid: 0, message: '非 Windows 平台不支持 WMI 创建进程' };
  const safe = String(commandLine).replace(/'/g, "''");
  const script =
    `$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create ` +
    `-Arguments @{ CommandLine = '${safe}' }; ` +
    'if ($r) { Write-Output ("$($r.ReturnValue) $($r.ProcessId)") }';
  const { ok, out, err } = await ps(script, 20000);
  const [code, pid] = out.split(/\s+/);
  if (ok && String(code).trim() === '0') {
    return { ok: true, pid: Number(pid) || 0, message: '' };
  }
  return { ok: false, pid: 0, message: err || out || 'WMI 创建进程失败' };
}

export async function setAutoStart(name, command) {
  if (!isWindows) return { ok: false, message: '非 Windows 平台不支持注册表自启' };
  // reg.exe 只认双引号参数；这里用 PowerShell 单引号串包裹 key/name（路径里的 \n 不会被当换行），
  // 而 /d 的值整体用一对双引号包住（路径不需要各自带引号，空格由这对外层引号处理）。
  const q = (s) => String(s).replace(/'/g, "''");
  const d = String(command).replace(/["']/g, '').replace(/'/g, "''");
  const { ok, out, err } = await ps(
    `reg.exe add '${RUN_KEY}' /v '${q(name)}' /t REG_SZ /d "${d}" /f`
  );
  return ok ? { ok: true } : { ok: false, message: err || out };
}

export async function clearAutoStart(name) {
  if (!isWindows) return { ok: false, message: '非 Windows 平台不支持注册表自启' };
  const q = (s) => String(s).replace(/'/g, "''");
  const { ok, out, err } = await ps(`reg.exe delete '${RUN_KEY}' /v '${q(name)}' /f`);
  return ok || /找不到|not found/i.test(out + err) ? { ok: true } : { ok: false, message: err || out };
}

export async function getAutoStart(name) {
  if (!isWindows) return '';
  const q = (s) => String(s).replace(/'/g, "''");
  const { out } = await ps(`reg.exe query '${RUN_KEY}' /v '${q(name)}' 2>$null`);
  const m = /REG_SZ\s+(.*)$/m.exec(out);
  return m ? m[1].trim() : '';
}

export function desktopDir() {
  return path.join(os.homedir(), 'Desktop');
}

export async function createShortcut(name, target, args = '', workdir = '') {
  if (!isWindows) return { ok: false, message: '非 Windows 平台不支持 .lnk' };
  const link = path.join(desktopDir(), `${name}.lnk`);
  // 用 PowerShell 单引号字符串：反斜杠路径里像 \n 这种不会被当成换行转义（之前用双引号会 ParserError）。
  const q = (s) => String(s).replace(/'/g, "''");
  const script = [
    '$ws = New-Object -ComObject WScript.Shell;',
    `$s = $ws.CreateShortcut('${q(link)}');`,
    `$s.TargetPath = '${q(target)}';`,
    `$s.Arguments = '${q(args)}';`,
    workdir ? `$s.WorkingDirectory = '${q(workdir)}';` : '',
    '$s.Save();',
    "'ok'",
  ].join(' ');
  const { ok, out, err } = await ps(script);
  return ok ? { ok: true, path: link } : { ok: false, message: err || out };
}

export async function removeShortcut(name) {
  if (!isWindows) return { ok: false, message: '非 Windows 平台不支持 .lnk' };
  const link = path.join(desktopDir(), `${name}.lnk`);
  try {
    if (fs.existsSync(link)) fs.unlinkSync(link);
    return { ok: true };
  } catch (err) {
    return { ok: false, message: err.message };
  }
}

/** 桌面快捷方式是否已存在（给界面显示用）。 */
export function shortcutPath(name) {
  return path.join(desktopDir(), `${name}.lnk`);
}

export function hasShortcut(name) {
  try {
    return fs.existsSync(shortcutPath(name));
  } catch {
    return false;
  }
}

export async function isRunning(pid) {
  if (!pid) return false;
  const { ok, out } = await ps(
    `if (Get-Process -Id ${Number(pid)} -ErrorAction SilentlyContinue) { "1" } else { "0" }`
  );
  return ok && out === '1';
}

export async function killProcess(pid, { force = true, timeoutMs = 5000 } = {}) {
  if (!pid) return { ok: false, message: '没有 pid' };
  // Stop-Process -Force 是异步终止，命令返回时进程可能还没真正退出。
  // 必须轮询等待，否则会误报「停止失败」。
  const { ok, out, err } = await ps(
    `Stop-Process -Id ${Number(pid)} ${force ? '-Force' : ''} -ErrorAction SilentlyContinue;` +
      ` $deadline = (Get-Date).AddMilliseconds(${Number(timeoutMs)});` +
      ` while ((Get-Process -Id ${Number(pid)} -ErrorAction SilentlyContinue) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 100 };` +
      ` if (Get-Process -Id ${Number(pid)} -ErrorAction SilentlyContinue) { "0" } else { "1" }`
  );
  if (ok && out === '1') return { ok: true };
  return { ok: false, message: err || (out === '0' ? `进程 ${pid} 在 ${timeoutMs}ms 内没有退出` : out) || '进程仍在' };
}

export async function isElevated() {
  const { out } = await ps(
    '$id=[Security.Principal.WindowsIdentity]::GetCurrent();' +
      '$p=New-Object Security.Principal.WindowsPrincipal($id);' +
      'if($p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){"1"}else{"0"}'
  );
  return out === '1';
}

/**
 * 以管理员身份重新拉起当前进程（UAC 自提升）。
 *
 * 为什么要它：注入 hook DLL 需要管理员权限，而「让用户自己找管理员终端」
 * 是新手最容易卡住的一步。这里用 Start-Process -Verb RunAs 弹一次 UAC，
 * 由系统自己提权，比让用户右键「以管理员身份运行」省事。
 *
 * @param {string[]} args 重新拉起时要带的参数
 */
export async function elevateSelf(args = []) {
  if (!isWindows) return { ok: false, message: '仅 Windows 支持提权' };
  if (await isElevated()) return { ok: true, message: '已经是管理员', elevated: false };
  const q = (s) => String(s).replace(/'/g, "''");
  const argList = args.length ? " -ArgumentList '" + q(args.join(' ')) + "'" : '';
  const script = "Start-Process -FilePath '" + q(process.execPath) + "'" + argList + ' -Verb RunAs';
  const { ok, err } = await ps(script);
  if (ok) return { ok: true, message: '已弹出提权窗口，请在新窗口里继续操作', elevated: true };
  return { ok: false, message: err || '提权失败' };
}
