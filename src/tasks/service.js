import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { ps, wmiCreate, killProcess, isRunning, isOurServicePid } from '../core/win.js';
import { PidFile } from '../core/pause.js';
import { dataDir, logFiles, pidFile, ROOT } from '../core/paths.js';

/**
 * 助手服务启停任务（任务层）。
 *
 * 职责边界：把服务跑起来 / 停下来 / 看它跑没跑只有这一处实现，
 * CLI 与图形化配置器都调它，避免两份后台启动逻辑各自漂移。
 */

/** 日志文件路径（后台运行时写在这里）。 */
export function serviceLogPaths(rootDir = ROOT) {
  return logFiles(rootDir);
}

/** 日志太大就轮转，保留 generations 代（默认 3），避免 data 目录越滚越大（L7）。 */
export function rotateLog(file, { maxBytes = 2 * 1024 * 1024, generations = 3 } = {}) {
  try {
    if (!fs.existsSync(file)) return;
    if (fs.statSync(file).size <= maxBytes) return;
    // 先把旧的 .1/.2 依次后移一代，腾出 .1 给当前文件
    for (let i = generations; i >= 1; i--) {
      const src = i === 1 ? file : `${file}.${i - 1}`;
      const dst = `${file}.${i}`;
      try {
        if (fs.existsSync(src)) {
          if (i === generations && fs.existsSync(dst)) fs.unlinkSync(dst);
          fs.renameSync(src, dst);
        }
      } catch {
        /* 某代移不动就跳过 */
      }
    }
  } catch {
    /* 滚不动就算了 */
  }
}

/**
 * 后台启动助手服务。
 *
 * 优先用 WMI：进程归 WMI 管，不在调用方的进程作业里，
 * 关掉配置器窗口、关掉终端都不会把服务带走。日志用 cmd 追加，不覆盖。
 */
export async function startBackground(rootDir = ROOT) {
  const dir = dataDir(rootDir);
  fs.mkdirSync(dir, { recursive: true });
  const entry = path.join(rootDir, 'src', 'index.js');
  const files = logFiles(rootDir);
  const q = (s) => String(s).replace(/"/g, '""');

  rotateLog(files.out);
  rotateLog(files.err);

  const cmdLine =
    'cmd.exe /c cd /d "' + q(rootDir) + '" && "' + q(process.execPath) + '" "' + q(entry) + '" ' +
    '>> "' + q(files.out) + '" 2>> "' + q(files.err) + '"';
  const wmi = await wmiCreate(cmdLine);
  if (wmi.ok) return { ok: true, pid: 0, method: 'wmi', message: '' };

  // 回退：PowerShell 的 Start-Process（也能跑，只是可能被父进程带走）
  // 路径一律用单引号串，避免路径里的反斜杠加字母被当成转义。
  const sq = (s) => String(s).replace(/'/g, "''");
  const script = [
    '$p = Start-Process -FilePath \'' + sq(process.execPath) + '\'',
    '-ArgumentList @(\'' + sq(entry) + '\')',
    '-WorkingDirectory \'' + sq(rootDir) + '\'',
    '-RedirectStandardOutput \'' + sq(files.out) + '\'',
    '-RedirectStandardError \'' + sq(files.err) + '\'',
    '-WindowStyle Hidden -PassThru;',
    'Write-Output $p.Id',
  ].join(' ');

  const { ok, out, err } = await ps(script);
  const pid = Number(String(out).split(/\s+/).pop()) || 0;
  return { ok: ok && pid > 0, pid, method: 'start-process', message: err || '' };
}

/** 停止助手服务（按 pid 文件找进程）。 */
export async function stopService(rootDir = ROOT) {
  const file = new PidFile({ file: pidFile(rootDir) });
  const pid = file.read();
  if (!pid || !(await isRunning(pid))) {
    file.clear();
    return { ok: true, message: '没有正在运行的助手服务' };
  }
  // GAP6 陈旧 pid：若 pid 指向非本服务进程（被 Windows 复用），不误杀他人，只清掉陈旧文件
  if (!(await isOurServicePid(pid))) {
    file.clear();
    return { ok: true, message: 'pid 指向非本服务进程，已清理陈旧的 pid 文件' };
  }
  const r = await killProcess(pid);
  if (r.ok) file.clear();
  return { ok: r.ok, message: r.message || ('已停止服务（pid ' + pid + '）') };
}

/** 服务当前状态。 */
export async function serviceStatus(rootDir = ROOT) {
  const file = new PidFile({ file: pidFile(rootDir) });
  const pid = file.read();
  let running = false;
  if (pid && (await isRunning(pid))) {
    // GAP6 陈旧 pid：活着的 pid 若不是本服务进程，视为陈旧并清理
    running = await isOurServicePid(pid);
    if (!running) file.clear();
  }
  return { running, pid: running ? pid : 0 };
}

/** 崩溃计数文件：异常退出次数记在 data/crash-count.json，用于体检标红。 */
export function crashCountFile(rootDir = ROOT) {
  return path.join(dataDir(rootDir), 'crash-count.json');
}

/** 读取崩溃次数。 */
export function readCrashCount(rootDir = ROOT) {
  try {
    const raw = JSON.parse(fs.readFileSync(crashCountFile(rootDir), 'utf8'));
    const n = Number(raw && raw.count);
    return Number.isFinite(n); n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

/** 累加崩溃次数。 */
export function bumpCrashCount(rootDir = ROOT) {
  const file = crashCountFile(rootDir);
  let count = 0;
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    count = Number(raw && raw.count) || 0;
  } catch {
    count = 0;
  }
  count += 1;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ count, at: new Date().toISOString() }, null, 2), 'utf8');
  } catch {
    /* 写不进去不影响主流程 */
  }
  return count;
}
