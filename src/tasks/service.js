import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { ps, wmiCreate, killProcess, isRunning, isOurServicePid, findProcessIds } from '../core/win.js';
import { PidFile } from '../core/pause.js';
import { dataDir, logFiles, pidFile, modelServicePidFile, ROOT } from '../core/paths.js';

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
 * 启动后再弹一个「可见的运行日志窗口」实时 tail 日志文件（见 openLogWindow），
 * 避免后台静默运行、用户看不到任何输出（黑屏）。
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
  if (wmi.ok) {
    await openLogWindow(rootDir);
    return { ok: true, pid: 0, method: 'wmi', message: '' };
  }

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
  const started = ok && pid > 0;
  if (started) await openLogWindow(rootDir);
  return { ok: started, pid, method: 'start-process', message: err || '' };
}

/**
 * 弹一个「可见的运行日志窗口」（cmd 控制台窗口，实时尾随 data/autochat.out / .err）。
 *
 * 为什么单独开窗口、而不是让助手在窗口里前台跑：
 *   - 助手主进程仍走 WMI 后台（脱离调用方进程作业，关掉配置器/IDE 也不会被带走，不会「莫名消失」）；
 *   - 但用户要能「看见运行记录」，所以专门弹一个窗口实时 tail 日志文件，避免后台黑屏看不到输出；
 *   - 关掉这个窗口只是关了「看日志的窗口」，并不会停掉助手；stop 时会一并关掉它。
 *
 * 命令行带 autochatlogtail 标记（写进 title），便于 stop 时精准定位并关闭（见 stopLogWindow）。
 * 实现：直接 cmd /k 弹窗，里面跑 powershell 的 Get-Content -Wait 尾随日志；
 * 路径用单引号（不嵌套双引号，避免 PowerShell 解析错位）。
 */
export async function openLogWindow(rootDir = ROOT) {
  const files = logFiles(rootDir);
  // 先确保日志文件存在，否则 Get-Content -Wait 会因文件不存在而报错停在错误页
  for (const f of [files.out, files.err]) {
    try {
      if (!fs.existsSync(f)) fs.writeFileSync(f, '');
    } catch {
      /* 忽略 */
    }
  }
  const q = (s) => String(s).replace(/'/g, "''");
  // 用 Start-Process 起 cmd /k：它立即返回，不会等窗口关闭（否则 ps() 会卡到超时）。
  // 窗口标题里写 autochatlogtail 标记，便于 stop 时按命令行命中。
  // 路径用单引号包，PowerShell 单引号串里单引号写成两个单引号。
  const pathArg = "''" + q(files.out) + "'',''" + q(files.err) + "''";
  // chcp 65001 把控制台切到 UTF-8 代码页（中文 Windows 默认 GBK/936，否则 UTF-8 中文会被当成 GBK 显示成乱码）；
  // Get-Content 显式 -Encoding utf8 读文件（日志是 Node 写的 UTF-8）。
  const cmdArg =
    'chcp 65001 >nul && title AutoChatLogTail&&powershell -NoProfile -NoExit -Command Get-Content -Encoding utf8 -Path ' +
    pathArg +
    ' -Wait -Tail 80';
  const script =
    "Start-Process -FilePath 'cmd.exe' -ArgumentList '/k', '" + cmdArg + "' -WindowStyle Normal";
  const { ok, err } = await ps(script);
  return { ok, pid: 0, message: err || '' };
}

/** 停止「由我们拉起的本地模型服务」（仅停自己起的，不碰用户自己开的程序）。 */
async function stopOwnModelService(rootDir = ROOT) {
  const file = modelServicePidFile(rootDir);
  let pid = 0;
  try {
    pid = Number(fs.readFileSync(file, 'utf8').trim());
  } catch {
    pid = 0;
  }
  if (!pid || !(await isRunning(pid))) {
    try {
      fs.unlinkSync(file);
    } catch {
      /* 没有就算了 */
    }
    return;
  }
  // 陈旧 pid：活着的若不是本服务进程，不误杀，只清理文件
  if (!(await isOurServicePid(pid))) {
    try {
      fs.unlinkSync(file);
    } catch {
      /* 忽略 */
    }
    return;
  }
  await killProcess(pid);
  try {
    fs.unlinkSync(file);
  } catch {
    /* 忽略 */
  }
}

/**
 * 停止配置器 GUI 进程（仅关我们启动的 GUI，不动用户自己开的程序）。
 *
 * GUI 没有 pid 文件、入口多样（`node src/cli/index.js gui` / `node src/gui/server.js`），
 * 只能按命令行命中。excludePid 用于「从 GUI 内调用 stop」时放过当前进程——
 * 由调用方自己延时退出，避免把正在回的 HTTP 响应掐掉。
 */
async function stopGui(rootDir = ROOT, { excludePid } = {}) {
  const cliEntry = path.join(ROOT, 'src', 'cli', 'index.js').toLowerCase();
  const serverEntry = path.join(ROOT, 'src', 'gui', 'server.js').toLowerCase();
  const hits = await findProcessIds([cliEntry, serverEntry]);
  for (const { pid, cmd } of hits) {
    if (pid === excludePid) continue;
    const isGui = cmd.includes(serverEntry) || (cmd.includes(cliEntry) && /\bgui\b/.test(cmd));
    if (!isGui) continue;
    await killProcess(pid);
  }
}

/** 停止助手服务（按 pid 文件找进程）。 */
export async function stopService(rootDir = ROOT) {
  const msgs = [];
  // 1) 助手主进程
  const file = new PidFile({ file: pidFile(rootDir) });
  const pid = file.read();
  if (!pid || !(await isRunning(pid))) {
    file.clear();
    msgs.push('没有正在运行的助手服务');
  } else if (!(await isOurServicePid(pid))) {
    // GAP6 陈旧 pid：若 pid 指向非本服务进程（被 Windows 复用），不误杀他人，只清掉陈旧文件
    file.clear();
    msgs.push('pid 指向非本服务进程，已清理陈旧的 pid 文件');
  } else {
    const r = await killProcess(pid);
    if (r.ok) file.clear();
    msgs.push(r.ok ? '已停止助手服务（pid ' + pid + '）' : r.message || '助手服务停止失败');
  }
  // 2) 我们拉起的本地模型服务（云端模型不碰）
  try {
    await stopOwnModelService(rootDir);
  } catch {
    /* 忽略 */
  }
  // 3) 配置器 GUI：放过当前进程，由调用方决定是否退场
  try {
    await stopGui(rootDir, { excludePid: process.pid });
  } catch {
    /* 忽略 */
  }
  // 4) 运行日志窗口（带 autochatlogtail 标记的控制台窗口）
  try {
    await stopLogWindow(rootDir);
  } catch {
    /* 忽略 */
  }
  return { ok: true, message: msgs.join('；') };
}

/** 关闭「运行日志窗口」（带 autochatlogtail 标记的控制台窗口，stop 时一并关掉）。 */
async function stopLogWindow(rootDir = ROOT) {
  const hits = await findProcessIds(['autochatlogtail']);
  for (const { pid } of hits) {
    if (pid === process.pid) continue;
    await killProcess(pid);
  }
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
