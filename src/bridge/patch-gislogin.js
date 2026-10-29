/**
 * 给自研 hook DLL（version.dll）补「g_IsLogin」门控。
 *
 * 背景：自研 aixed 系 DLL 里 DatabaseMgr::searchDatabases() 第一行是
 *     if (!g_IsLogin) return {};
 * g_IsLogin 靠登录事件置位，在某些版本上失败 → 所有 QueryDB 返回空、取不到库句柄，
 * 但微信其实已登录。把这个 bool 改成 1，查库和取密钥就都能用了。
 *
 * 难点：自研 DLL 把自己从模块列表摘掉了，Module32 拿不到基址。
 * 所以这里扫内存找 DLL 内唯一字符串反推基址，再写 g_IsLogin（值为 0 的那个候选）。
 *
 * 不同构建用的定位字符串不同（见下方 MARKERS）。任一命中即按它的候选 RVA 处理；
 * 全不命中说明当前 DLL 不是自研份，安全跳过（不会误改别的模块）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { decodeCliText } from '../core/text.js';

// 不同自研 DLL 构建用不同字符串定位基址（Module32 拿不到，只能扫内存）。
// 每个 marker 对应其构建里 g_IsLogin 的候选 RVA 列表（写第一个值为 0 的）。
const MARKERS = [
  // 旧版自研 DLL（文件含 "PRAGMA database_list"）
  { str: 'PRAGMA database_list', rva: 0x58ed0, cands: [0x6d480, 0x736a0, 0x73668] },
  // version-ac-4.1.10.27.dll（当前 4.1.10.27 内置 DLL，无 PRAGMA database_list）：
  // 用唯一字符串 "get database handle which named %s failed" 定位，g_IsLogin@0x1f22f0
  { str: 'get database handle which named %s failed', rva: 0x1a8460, cands: [0x1f22f0] },
];

function buildCsSource() {
  const markerBytes = MARKERS.map((m) => `Encoding.ASCII.GetBytes("${m.str}")`).join(',\n        ');
  const markerRvas = MARKERS.map((m) => `new long[]{ ${m.rva} }`).join(', ');
  const markerCands = MARKERS.map((m) => `new long[]{ ${m.cands.map((c) => '0x' + c.toString(16)).join(', ')} }`).join(', ');
  return `
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class GisLoginPatcher
{
    const uint PROCESS_ALL_ACCESS = 0x1F0FFF;
    const uint MEM_COMMIT = 0x1000;
    const uint MEM_IMAGE = 0x1000000;
    const uint PAGE_READABLE = 0x04 | 0x02 | 0x40;

    [StructLayout(LayoutKind.Sequential, Pack = 8)]
    struct MEMORY_BASIC_INFORMATION {
        public IntPtr BaseAddress;
        public IntPtr AllocationBase;
        public uint AllocationProtect;
        public IntPtr RegionSize;
        public uint State;
        public uint Protect;
        public uint Type;
    }

    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint a, bool i, int pid);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool ReadProcessMemory(IntPtr h, IntPtr addr, byte[] buf, uint size, out UIntPtr read);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool WriteProcessMemory(IntPtr h, IntPtr addr, byte[] buf, uint size, out UIntPtr written);
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr VirtualQueryEx(IntPtr h, IntPtr addr, out MEMORY_BASIC_INFORMATION mbi, uint size);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr h);

    static int IndexOf(byte[] hay, int start, int count, byte[] needle) {
        for (int i = start; i + needle.Length <= start + count; i++) {
            bool ok = true;
            for (int j = 0; j < needle.Length; j++) if (hay[i + j] != needle[j]) { ok = false; break; }
            if (ok) return i;
        }
        return -1;
    }

    static long SearchBase(IntPtr h, byte[] marker, long stringRva) {
        var mbi = new MEMORY_BASIC_INFORMATION();
        long addr = 0;
        long max = 0x7FFFFFFF0000;
        int mbiSize = Marshal.SizeOf(typeof(MEMORY_BASIC_INFORMATION));
        while (addr < max) {
            if (VirtualQueryEx(h, (IntPtr)addr, out mbi, (uint)mbiSize) == IntPtr.Zero) { addr += 0x10000; continue; }
            long size = (long)mbi.RegionSize;
            if (mbi.State == MEM_COMMIT && (mbi.Type & MEM_IMAGE) != 0 && ((mbi.Protect & PAGE_READABLE) != 0)) {
                long regionBase = (long)mbi.BaseAddress;
                long remaining = size; long off = 0;
                while (remaining > 0) {
                    int chunk = (int)Math.Min(remaining, 4 * 1024 * 1024);
                    byte[] buf = new byte[chunk];
                    UIntPtr rd;
                    if (ReadProcessMemory(h, (IntPtr)(regionBase + off), buf, (uint)chunk, out rd)) {
                        int read = (int)rd;
                        int idx = IndexOf(buf, 0, read, marker);
                        if (idx >= 0) {
                            long abs = regionBase + off + idx;
                            long dllBase = abs - stringRva;
                            byte[] mz = new byte[2]; UIntPtr r2;
                            if (ReadProcessMemory(h, (IntPtr)dllBase, mz, 2, out r2) && mz[0] == (byte)'M' && mz[1] == (byte)'Z')
                                return dllBase;
                        }
                    }
                    off += chunk; remaining -= chunk;
                }
            }
            addr += size; if (size == 0) addr += 0x10000;
        }
        return 0;
    }

    static long ReadQword(IntPtr h, long addr) {
        byte[] b = new byte[8]; UIntPtr rd;
        if (ReadProcessMemory(h, (IntPtr)addr, b, 8, out rd) && (int)rd == 8) return BitConverter.ToInt64(b, 0);
        return -1;
    }

    public static string Patch(int pid) {
        if (pid <= 0) return "ERR:no-pid";
        IntPtr h = OpenProcess(PROCESS_ALL_ACCESS, false, pid);
        if (h == IntPtr.Zero) return "ERR:OpenProcess:" + Marshal.GetLastWin32Error();
        try {
            byte[][] mb = new byte[][] { ${markerBytes} };
            long[][] mr = new long[][] { ${markerRvas} };
            long[][] mc = new long[][] { ${markerCands} };
            var sb = new StringBuilder();
            bool done = false;
            bool foundAny = false;
            for (int i = 0; i < mb.Length && !done; i++) {
                long baseAddr = SearchBase(h, mb[i], mr[i][0]);
                if (baseAddr == 0) continue;
                foundAny = true;
                sb.Append("marker").Append(i).Append("_base=0x").Append(baseAddr.ToString("x12")).Append(" ");
                foreach (var rva in mc[i]) {
                    long v = ReadQword(h, baseAddr + rva);
                    sb.Append("rva=0x").Append(rva.ToString("x")).Append("=0x").Append(v.ToString("x")).Append(" ");
                    if (v == 0) {
                        byte[] one = BitConverter.GetBytes((long)1);
                        UIntPtr w;
                        bool ok = WriteProcessMemory(h, (IntPtr)(baseAddr + rva), one, 8, out w);
                        sb.Append("patched=0x").Append((baseAddr + rva).ToString("x12")).Append(" ok=").Append(ok).Append(" ");
                        done = true; break;
                    }
                }
                if (done) return "OK:" + sb.ToString();
            }
            if (foundAny) { sb.Append("(already-on/no-zero)"); return "OK:" + sb.ToString(); }
            return "ERR:marker-not-found(no-self-dll) " + sb.ToString();
        } finally { CloseHandle(h); }
    }
}
`;
}

const CS_SOURCE = buildCsSource();

function ps(script, timeout = 60000) {
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true, timeout, maxBuffer: 8 * 1024 * 1024 },
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
  const file = path.join(dir, 'GisLoginPatcher.cs');
  fs.writeFileSync(file, CS_SOURCE, 'utf8');
  return file;
}

let csFile = null;

/** 找到微信主进程 pid（排除 --type= 子进程）。 */
export async function findMainWeixinPid() {
  const { out } = await ps(
    "Get-CimInstance Win32_Process -Filter \"Name='Weixin.exe'\" | " +
      "Where-Object { $_.CommandLine -notmatch '--type=' } | " +
      "Sort-Object ProcessId | Select-Object -First 1 -ExpandProperty ProcessId"
  );
  const pid = parseInt(out, 10);
  return Number.isFinite(pid) && pid > 0 ? pid : null;
}

/**
 * 给自研 DLL 补 g_IsLogin 门控。返回 { ok, detail }。
 * 非致命：没找到自研 DLL 就返回 ok:false 但说明是 skipped，调用方不应中断启动。
 */
export async function patchGisLogin() {
  if (!csFile) csFile = cacheCs();
  const pid = await findMainWeixinPid();
  if (!pid) return { ok: false, detail: '找不到微信主进程' };
  const safe = csFile.replace(/'/g, "''");
  const script =
    `Add-Type -TypeDefinition ([IO.File]::ReadAllText('${safe}')) -Language CSharp; ` +
    `[GisLoginPatcher]::Patch(${Number(pid)})`;
  const { ok, out, err } = await ps(script);
  if (!ok) return { ok: false, detail: err || out || 'powershell 失败' };
  if (out.startsWith('OK:')) return { ok: true, detail: out.slice(3) };
  return { ok: false, detail: out };
}
