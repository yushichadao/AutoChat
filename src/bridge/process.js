import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_WECHAT_PATHS = [
  'C:\\Program Files\\Tencent\\Weixin\\Weixin.exe',
  'C:\\Program Files (x86)\\Tencent\\Weixin\\Weixin.exe',
  'C:\\Program Files\\Tencent\\WeChat\\WeChat.exe',
  'C:\\Program Files (x86)\\Tencent\\WeChat\\WeChat.exe',
  'D:\\Weixin\\Weixin.exe',
  'D:\\WeChat\\WeChat.exe',
];

function runPowerShell(script) {
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true, timeout: 15000, maxBuffer: 1024 * 1024 },
      (err, stdout) => resolve({ ok: !err, out: String(stdout || '').trim(), err })
    );
  });
}

/** 按注册表 → 常见路径的顺序探测微信安装位置，返回 { exe, dir, version } 或 null。 */
export async function detectWeChat(installDir = '') {
  if (installDir) {
    const exe = path.join(installDir, 'Weixin.exe');
    const alt = path.join(installDir, 'WeChat.exe');
    const found = fs.existsSync(exe) ? exe : fs.existsSync(alt) ? alt : null;
    if (found) return describe(found);
  }

  const reg = await runPowerShell(
    "$p=(Get-ItemProperty 'HKCU:\\Software\\Tencent\\Weixin' -ErrorAction SilentlyContinue).InstallPath;" +
      "if(-not $p){$p=(Get-ItemProperty 'HKCU:\\Software\\Tencent\\WeChat' -ErrorAction SilentlyContinue).InstallPath};" +
      'if($p){Write-Output $p}'
  );
  if (reg.out) {
    for (const name of ['Weixin.exe', 'WeChat.exe']) {
      const exe = path.join(reg.out, name);
      if (fs.existsSync(exe)) return describe(exe);
    }
  }

  for (const exe of DEFAULT_WECHAT_PATHS) {
    if (fs.existsSync(exe)) return describe(exe);
  }
  return null;
}

function describe(exe) {
  const dir = path.dirname(exe);
  const version = readVersion(exe);
  return { exe, dir, version, major: version ? Number(version.split('.')[0]) : 0 };
}

export function readVersion(exe) {
  try {
    return execFileSync(
      'powershell.exe',
      ['-NoProfile', '-Command', `(Get-Item '${exe.replace(/'/g, "''")}').VersionInfo.FileVersion`],
      { encoding: 'utf8', windowsHide: true, timeout: 10000 }
    ).trim();
  } catch {
    return '';
  }
}

/**
 * 列出微信主进程。
 * 微信 4.x 会起多个同名 Weixin.exe（--type=wxocr/wxutility 等子进程），
 * 只有不带 --type= 的那个是可注入的主进程。
 */
export async function listWeChatProcesses(processName = 'Weixin.exe') {
  const script =
    `Get-CimInstance Win32_Process -Filter "Name='${processName}'" -ErrorAction SilentlyContinue | ` +
    'Select-Object ProcessId,ExecutablePath,CommandLine | ConvertTo-Json -Compress';
  const { ok, out } = await runPowerShell(script);
  if (!ok || !out) return [];
  let data;
  try {
    data = JSON.parse(out);
  } catch {
    return [];
  }
  const list = Array.isArray(data) ? data : [data];
  return list
    .filter((p) => p && p.ExecutablePath && /[\\/](Weixin|WeChat)\.exe$/i.test(p.ExecutablePath))
    .filter((p) => !/--type=/i.test(p.CommandLine || ''))
    .map((p) => ({ pid: Number(p.ProcessId), exe: p.ExecutablePath }));
}

/** 判断某个 pid 的进程是否还活着（用于单实例保护）。 */
export async function isProcessAlive(pid) {
  const n = Number(pid);
  if (!Number.isFinite(n) || n <= 0) return false;
  const { out } = await runPowerShell(
    `if (Get-Process -Id ${n} -ErrorAction SilentlyContinue) { Write-Output 1 } else { Write-Output 0 }`
  );
  return out.trim() === '1';
}

/** 判断微信进程是否已加载指定 DLL（按文件名匹配），用于识别注入是否生效。 */
export async function hasModuleLoaded(pid, dllName) {
  const script =
    `$m = Get-Process -Id ${Number(pid)} -Module -ErrorAction SilentlyContinue | ` +
    `Where-Object { $_.ModuleName -eq '${dllName.replace(/'/g, "''")}' }; if($m){1}else{0}`;
  const { out } = await runPowerShell(script);
  return out === '1';
}

export async function isPortOpen(host, port, timeoutMs = 800) {
  const net = await import('node:net');
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (v) => {
      socket.destroy();
      resolve(v);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

export { DEFAULT_WECHAT_PATHS };
