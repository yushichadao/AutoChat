import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { decodeCliText } from '../core/text.js';

/**
 * 把 hook DLL 映射进目标进程（Weixin.exe）。
 *
 * 用 Windows 自带的 CreateRemoteThread + LoadLibraryW，不额外依赖原生模块；
 * 也提供 proxy 模式：把 DLL 复制成 version.dll 放进微信目录，由系统加载器载入。
 * 卸载用 `npm run uninstall-service` 还原 version.dll。
 */
const CS_SOURCE = `
using System;
using System.Runtime.InteropServices;

public static class WxInjector
{
    const uint PROCESS_ALL_ACCESS = 0x1F0FFF;
    const uint MEM_COMMIT_RESERVE = 0x3000;
    const uint PAGE_READWRITE = 0x04;
    const uint MEM_RELEASE = 0x8000;
    const uint INFINITE = 0xFFFFFFFF;

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr OpenProcess(uint access, bool inherit, int pid);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr VirtualAllocEx(IntPtr h, IntPtr addr, uint size, uint type, uint protect);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool WriteProcessMemory(IntPtr h, IntPtr addr, byte[] buf, uint size, out UIntPtr written);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr GetProcAddress(IntPtr hModule, string name);

    [DllImport("kernel32.dll", CharSet = CharSet.Auto)]
    static extern IntPtr GetModuleHandle(string name);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr CreateRemoteThread(IntPtr h, IntPtr attr, uint stack, IntPtr start, IntPtr param, uint flags, IntPtr tid);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern uint WaitForSingleObject(IntPtr h, uint ms);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool GetExitCodeThread(IntPtr h, out uint code);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool VirtualFreeEx(IntPtr h, IntPtr addr, uint size, uint type);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool CloseHandle(IntPtr h);

    public static string Inject(int pid, string dllPath)
    {
        IntPtr proc = OpenProcess(PROCESS_ALL_ACCESS, false, pid);
        if (proc == IntPtr.Zero)
            return "ERR:OpenProcess:" + Marshal.GetLastWin32Error();

        IntPtr remote = IntPtr.Zero;
        IntPtr thread = IntPtr.Zero;
        try
        {
            byte[] bytes = System.Text.Encoding.Unicode.GetBytes(dllPath + "\\0");
            remote = VirtualAllocEx(proc, IntPtr.Zero, (uint)bytes.Length, MEM_COMMIT_RESERVE, PAGE_READWRITE);
            if (remote == IntPtr.Zero)
                return "ERR:VirtualAllocEx:" + Marshal.GetLastWin32Error();

            UIntPtr written;
            if (!WriteProcessMemory(proc, remote, bytes, (uint)bytes.Length, out written))
                return "ERR:WriteProcessMemory:" + Marshal.GetLastWin32Error();

            IntPtr kernel32 = GetModuleHandle("kernel32.dll");
            IntPtr loadLibrary = GetProcAddress(kernel32, "LoadLibraryW");
            if (loadLibrary == IntPtr.Zero)
                return "ERR:GetProcAddress:" + Marshal.GetLastWin32Error();

            thread = CreateRemoteThread(proc, IntPtr.Zero, 0, loadLibrary, remote, 0, IntPtr.Zero);
            if (thread == IntPtr.Zero)
                return "ERR:CreateRemoteThread:" + Marshal.GetLastWin32Error();

            WaitForSingleObject(thread, INFINITE);
            uint code;
            GetExitCodeThread(thread, out code);
            if (code == 0)
                return "ERR:LoadLibraryReturnedZero";
            return "OK:" + code;
        }
        finally
        {
            if (thread != IntPtr.Zero) CloseHandle(thread);
            if (remote != IntPtr.Zero) VirtualFreeEx(proc, remote, 0, MEM_RELEASE);
            CloseHandle(proc);
        }
    }
}
`;

function ps(script, timeout = 60000) {
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

function cacheCs() {
  const dir = path.join(os.tmpdir(), 'autochat');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'WxInjector.cs');
  fs.writeFileSync(file, CS_SOURCE, 'utf8');
  return file;
}

export async function isElevated() {
  const { out } = await ps(
    '$id=[Security.Principal.WindowsIdentity]::GetCurrent();' +
      '$p=New-Object Security.Principal.WindowsPrincipal($id);' +
      'if($p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){"1"}else{"0"}'
  );
  return out === '1';
}

/** 对已运行的进程注入 DLL，返回 { ok, detail }。 */
export async function injectDll(pid, dllPath) {
  if (!fs.existsSync(dllPath)) return { ok: false, detail: `DLL 不存在: ${dllPath}` };

  const cs = cacheCs();
  // PowerShell 单引号串不展开 $() / 反引号，用它承载路径可杜绝命令注入；再把串内单引号转义为 ''。
  // dllPath 作为变量 $dllPath 传参，不嵌入双引号串，从源头消除 $(...) 子表达式注入。
  const safeSingle = (s) => String(s).replace(/'/g, "''");
  const script =
    `$dllPath = '${safeSingle(dllPath)}';` +
    `Add-Type -TypeDefinition ([IO.File]::ReadAllText('${safeSingle(cs)}')) -Language CSharp;` +
    `[WxInjector]::Inject(${Number(pid)}, $dllPath)`;

  const { ok, out, err } = await ps(script);
  if (!ok) return { ok: false, detail: err || out || 'powershell 执行失败' };
  if (out.startsWith('OK:')) return { ok: true, detail: out.slice(3) };
  return { ok: false, detail: out };
}

/** 代理式加载：把 DLL 复制成 version.dll 放进微信目录（重启后由系统加载器载入）。 */
export async function deployProxyDll(installDir, dllPath, backup = true) {
  const target = path.join(installDir, 'version.dll');
  if (!fs.existsSync(dllPath)) throw new Error(`DLL 不存在: ${dllPath}`);

  if (backup && fs.existsSync(target) && !fs.existsSync(`${target}.bak`)) {
    try {
      fs.copyFileSync(target, `${target}.bak`);
    } catch {
      /* 被占用就跳过备份，下面还有改名兜底 */
    }
  }
  try {
    fs.copyFileSync(dllPath, target);
  } catch (err) {
    // 微信正在运行：已加载的 version.dll 会被锁（EBUSY/EPERM），直接覆盖会失败。
    // Windows 允许给已加载的 DLL 改名，先挪走再写新的，重启微信即生效。
    if (err && (err.code === 'EBUSY' || err.code === 'EPERM' || err.code === 'EACCES')) {
      fs.renameSync(target, `${target}.old-${Date.now()}`);
      fs.copyFileSync(dllPath, target);
      return target;
    }
    throw err;
  }
  return target;
}

/** 结束所有微信主进程。 */
export async function killWeChat(processName = 'Weixin.exe') {
  const name = processName.replace(/\.exe$/i, '');
  const { ok, out } = await ps(`Stop-Process -Name '${name.replace(/'/g, "''")}' -Force -ErrorAction SilentlyContinue; "done"`);
  return ok && out === 'done';
}

/** 带启动参数拉起微信（hook DLL 从这个命令行读端口与回调地址）。 */
export async function launchWeChat(exe, args = []) {
  const quoted = args.map((a) => `"${String(a).replace(/"/g, '\\"')}"`).join(' ');
  const { ok, err } = await ps(`Start-Process -FilePath "${exe.replace(/"/g, '\\"')}" -ArgumentList '${quoted}'; "ok"`);
  return { ok, detail: err };
}
