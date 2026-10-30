import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { ROOT } from './paths.js';
import { decodeCliText, isDamagedText } from './text.js';

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
        resolve({
          ok: !err,
          // 子进程按系统代码页输出中文，必须按代码页解码，否则是乱码（且不可逆）
          out: decodeCliText(stdout).trim(),
          err: decodeCliText(stderr).trim(),
        })
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

/**
 * 直接调 reg.exe（**不经 PowerShell**）。
 *
 * 两个原因：
 *  1. **中文错误不会在 PowerShell 内部被毁掉**：PowerShell 用 [Console]::OutputEncoding
 *     去解原生命令的输出，本机它是 utf-8，而 reg.exe 的中文报错是 CP936 字节 ——
 *     解不出来的字节在 PowerShell 里就变成 U+FFFD，Node 侧再也还原不回原文
 *     （终端上表现为满屏「锟斤拷」）。绕开 PowerShell 才能拿到原始字节、按代码页正确解码。
 *  2. **不用拼命令行字符串**：execFile 走 argv 数组，值里有空格/引号都不会出事。
 *
 * reg.exe 成功时退出码 0；值或键不存在时退出码非 0，并把中文错误写进 stderr。
 */
export function reg(args, timeout = 15000) {
  return new Promise((resolve) => {
    execFile(
      'reg.exe',
      args,
      { windowsHide: true, timeout, maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) =>
        resolve({
          ok: !err,
          code: err && typeof err.code === 'number' ? err.code : 0,
          out: decodeCliText(stdout).trim(),
          err: decodeCliText(stderr).trim(),
        })
    );
  });
}

/**
 * 系统报错的原文只在「干净」时才敢往界面上放。
 *
 * 实测：本机控制台代码页是 65001(UTF-8)，reg.exe 的中文报错在进 Node 之前就被系统
 * 转换坏了一半（U+FFFD 替换符 + 残留 CP936 字节），这种文本**还原不回来**，
 * 直接展示就是满屏乱码。所以：损坏就丢弃，只留我们自己写的中文说明。
 *
 * @param {string} text
 * @returns {string} 干净的原文，或空串（损坏/为空）
 */
export function cleanOsMessage(text) {
  const s = String(text || '').trim();
  if (!s || isDamagedText(s)) return '';
  return s;
}

export async function setAutoStart(name, command) {
  if (!isWindows) return { ok: false, message: '非 Windows 平台不支持注册表自启' };
  // argv 数组传参：/d 的值里有空格、中文、引号都不用自己加引号
  const r = await reg([
    'add',
    RUN_KEY,
    '/v',
    String(name),
    '/t',
    'REG_SZ',
    '/d',
    String(command),
    '/f',
  ]);
  if (r.ok) return { ok: true };
  const detail = cleanOsMessage(r.err) || cleanOsMessage(r.out);
  return { ok: false, message: detail ? `注册开机自启失败：${detail}` : '注册开机自启失败' };
}

export async function clearAutoStart(name) {
  if (!isWindows) return { ok: false, message: '非 Windows 平台不支持注册表自启' };
  /**
   * 「本来就没注册过」是正常状态，不是错误。
   * reg.exe 对不存在的值会返回非 0、并把中文错误写进 stderr。直接当失败会有两个毛病：
   *   ① uninstall 凭空多出一条 ✗（明明没有自启要取消）；
   *   ② 那条错误文案是系统中文，不按代码页解码就显示成乱码。
   * 所以：先查在不在，不在直接算成功；删完再复查一次，确认是否已消失。
   */
  const before = await reg(['query', RUN_KEY, '/v', String(name)]);
  if (!before.ok) return { ok: true, message: '' };
  const del = await reg(['delete', RUN_KEY, '/v', String(name), '/f']);
  if (del.ok) return { ok: true, message: '' };
  const after = await reg(['query', RUN_KEY, '/v', String(name)]);
  if (!after.ok) return { ok: true, message: '' };
  const detail = cleanOsMessage(del.err) || cleanOsMessage(del.out);
  return { ok: false, message: detail ? `删除开机自启失败：${detail}` : '删除开机自启失败' };
}

export async function getAutoStart(name) {
  if (!isWindows) return '';
  const r = await reg(['query', RUN_KEY, '/v', String(name)]);
  if (!r.ok) return '';
  const m = /REG_SZ\s+(.*)$/m.exec(r.out);
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

/**
 * 判断某个 pid 是否真的是「本助手服务」进程（而非 pid 被复用成的其他进程）。
 *
 * 为什么需要它（GAP6 陈旧 pid）：仅看进程是否存活会中招——Windows 会复用 pid，
 * 陈旧的 autochat.pid 可能指向一个无关活进程，导致单实例保护误判「已有实例」而拒绝启动，
 * 或 stop 误杀他人进程。这里进一步校验命令行确实是我们自己的入口。
 *
 * @param {number|string} pid
 * @param {{marker?:string}} [opts] 入口标记，默认本工程 src/index.js 绝对路径
 */
export async function isOurServicePid(pid, { marker } = {}) {
  const n = Number(pid);
  if (!Number.isFinite(n) || n <= 0) return false;
  const entry = String(marker || path.join(ROOT, 'src', 'index.js')).toLowerCase();
  try {
    const { out } = await ps(
      `Get-CimInstance Win32_Process -Filter "ProcessId=${n}" -ErrorAction SilentlyContinue | ` +
        'Select-Object -ExpandProperty CommandLine'
    );
    const cmd = String(out || '').toLowerCase();
    if (!cmd) return false; // 拿不到命令行（权限等）就不认，宁可放过也不误杀
    if (cmd.includes(entry)) return true;
    // 兜底：是 node 进程且命令行带 index.js（跨安装目录也能识别）
    return cmd.includes('node') && cmd.includes('index.js');
  } catch {
    return false;
  }
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

/**
 * 按命令行标记列出本机进程（用于「一键全关」时连带关掉配置器 GUI 等）。
 *
 * 为什么需要它：配置器 GUI 没有 pid 文件（启动入口多样：
 * `node src/cli/index.js gui`、`node src/gui/server.js`），只能靠命令行命中。
 * 返回 [{ pid, cmd }]，cmd 已转小写，便于调用方自行过滤（比如排除当前进程）。
 *
 * @param {string[]} markers 命令行（小写）包含其中任一即命中
 */
export async function findProcessIds(markers) {
  const norm = (markers || [])
    .map((m) => String(m).toLowerCase().replace(/\\/g, '/'))
    .filter(Boolean);
  if (!norm.length) return [];
  try {
    const { out } = await ps(
      'Get-CimInstance Win32_Process | Select-Object ProcessId, CommandLine | ' +
        'ForEach-Object { if ($_.CommandLine) { ($_.ProcessId.ToString() + " " + $_.CommandLine) } }'
    );
    const lines = String(out || '').split(/\r?\n/);
    const seen = new Set();
    const result = [];
    for (const ln of lines) {
      const sp = ln.indexOf(' ');
      if (sp < 0) continue;
      const pid = Number(ln.slice(0, sp));
      // 命令行里的路径是反斜杠，统一转成斜杠再比，避免 Windows 路径分隔符对不上
      const cmd = ln
        .slice(sp + 1)
        .toLowerCase()
        .replace(/\\/g, '/');
      if (!Number.isFinite(pid) || pid <= 0) continue;
      if (seen.has(pid)) continue;
      if (norm.some((m) => cmd.includes(m))) {
        seen.add(pid);
        result.push({ pid, cmd });
      }
    }
    return result;
  } catch {
    return [];
  }
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
