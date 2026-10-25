import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import os from 'node:os';
import { execFileSync, spawn } from 'node:child_process';
import { killProcess, isRunning } from '../core/win.js';
import { modelServicePidFile, ROOT } from '../core/paths.js';
import { listModels } from './model.js';
import { writeEditableEnv } from './config.js';

/**
 * 本地模型服务任务（任务层）。
 *
 * 职责边界：只管「本机的模型服务进程」——探测有没有装、拉起来、等就绪、停掉。
 * 云端模型由服务商托管，这里不碰。
 *
 * 安全：不下载、不安装任何东西；只启动本机已安装、且用户明确指定的程序；
 * 只停「由我们启动的」（pid 在册）进程，不越权结束用户自己开的进程。
 */

export const DEFAULT_READY_TIMEOUT_MS = 30000;

/** 已知本地模型服务（id → 展示名与默认地址）。 */
export const RUNNERS = [
  { id: 'ollama', name: 'Ollama', baseUrl: 'http://127.0.0.1:11434/v1', cmd: 'ollama serve' },
  { id: 'lmstudio', name: 'LM Studio', baseUrl: 'http://127.0.0.1:1234/v1', cmd: '' },
  { id: 'llamacpp', name: 'llama.cpp / vLLM / One-API', baseUrl: 'http://127.0.0.1:8000/v1', cmd: '' },
];

/** 本地常见的安装位置。 */
export function localRunnerExes() {
  const local = process.env.LOCALAPPDATA || '';
  return {
    ollama: [
      path.join(local, 'Programs', 'Ollama', 'ollama.exe'),
      path.join(local, 'Ollama', 'ollama.exe'),
    ],
    lmstudio: [path.join(local, 'LM-Studio', 'LM-Studio.exe')],
    llamacpp: [],
  };
}

/** 在 PATH 与常见安装目录里找可执行文件。 */
export function findExe(name, extra = []) {
  for (const p of extra) {
    if (!p) continue;
    try {
      if (fs.existsSync(p)) return p;
    } catch {
      /* 忽略 */
    }
  }
  if (!name) return '';
  try {
    const out = execFileSync('where', [name], { windowsHide: true });
    const first = String(out || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
    if (first) return first;
  } catch {
    /* 没找到 */
  }
  return '';
}

/** 探测本机装了哪些本地模型服务。 */
export async function detectLocalRunners({ rootDir = ROOT, runnerId = '' } = {}) {
  const exes = localRunnerExes();
  const out = [];
  for (const r of RUNNERS) {
    if (runnerId) {
      if (r.id !== runnerId) continue;
    }
    const exe = findExe(
      r.id === 'ollama' ? 'ollama' : r.id === 'lmstudio' ? 'LM Studio' : '',
      exes[r.id] || []
    );
    out.push({
      id: r.id,
      name: r.name,
      baseUrl: r.baseUrl,
      cmd: r.cmd,
      exe,
      installed: Boolean(exe) ? true : r.id === 'llamacpp',
      canStart: r.cmd ? Boolean(exe) || r.id === 'ollama' : false,
    });
  }
  return out;
}

/** 读一次模型列表：通不通、有哪些模型。 */
export async function probeModelService(baseUrl, timeoutMs = 3000) {
  if (!baseUrl) return { ok: false, models: [], error: '没有配置模型地址' };
  try {
    const r = await listModels({ baseUrl, timeoutMs });
    return { ok: Boolean(r.ok), models: r.models || [], error: r.error || '' };
  } catch (err) {
    return { ok: false, models: [], error: err.message };
  }
}

/** 我们启动的模型服务进程 pid（没有则 0）。 */
export function startedPid(rootDir = ROOT) {
  try {
    const n = Number(fs.readFileSync(modelServicePidFile(rootDir), 'utf8').trim());
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

/** 等待模型服务就绪（轮询模型列表）。 */
export async function waitForReady(baseUrl, timeoutMs = DEFAULT_READY_TIMEOUT_MS) {
  const deadline = Date.now() + Math.max(1000, Number(timeoutMs) || DEFAULT_READY_TIMEOUT_MS);
  let last = { ok: false, models: [], error: '还没开始探测' };
  while (Date.now() < deadline) {
    last = await probeModelService(baseUrl, 2000);
    if (last.ok) return last;
    await new Promise((r) => setTimeout(r, 800));
  }
  return last;
}

/**
 * 启动本地模型服务并等待就绪。
 */
export async function startModelService(opts = {}) {
  const rootDir = opts.rootDir || ROOT;
  const runners = await detectLocalRunners({ rootDir, runnerId: opts.runnerId });
  const runner = runners[0];
  if (!runner) return { ok: false, message: '没有可用的本地模型服务' };

  let cmd = opts.cmd || runner.cmd;
  if (!cmd) {
    if (runner.id === 'lmstudio') {
      return {
        ok: false,
        needsManual: true,
        message: 'LM Studio 需要手动打开：启动软件 → Local Server → Start Server',
        runner,
      };
    }
    return {
      ok: false,
      needsManual: true,
      message: '这个模型服务需要你提供启动命令（配置项 MODEL_SERVICE_CMD）',
      runner,
    };
  }
  if (runner.id === 'ollama' && runner.exe) {
    cmd = '"' + runner.exe + '" serve';
  }

  const baseUrl = opts.baseUrl || runner.baseUrl;
  const child = spawn(cmd, {
    cwd: rootDir,
    detached: true,
    windowsHide: true,
    stdio: 'ignore',
    shell: true,
  });
  child.unref();
  const pid = child.pid || 0;
  if (pid) {
    try {
      fs.mkdirSync(path.dirname(modelServicePidFile(rootDir)), { recursive: true });
      fs.writeFileSync(modelServicePidFile(rootDir), String(pid));
    } catch {
      /* 写不进去不影响启动 */
    }
  }

  const ready = await waitForReady(baseUrl, opts.timeoutMs);
  if (!ready.ok) {
    return {
      ok: false,
      pid,
      runner,
      message: '已尝试启动，但服务没有在预期时间内就绪',
      detail: ready.error || '',
    };
  }
  return { ok: true, pid, runner, baseUrl, models: ready.models, message: '模型服务已就绪' };
}

/**
 * 停止「由我们启动的」模型服务。
 * 用户自己启动的（没有 pid 记录）不越权结束，只提示手动关闭。
 */
export async function stopModelService({ rootDir = ROOT } = {}) {
  const pid = startedPid(rootDir);
  if (!pid) {
    return { ok: false, message: '没有由 AutoChat 启动的模型服务（如果是自己开的，请手动关闭）' };
  }
  if (!(await isRunning(pid))) {
    try {
      fs.unlinkSync(modelServicePidFile(rootDir));
    } catch {
      /* 忽略 */
    }
    return { ok: true, message: '模型服务已经不在运行了' };
  }
  const r = await killProcess(pid);
  if (r.ok) {
    try {
      fs.unlinkSync(modelServicePidFile(rootDir));
    } catch {
      /* 忽略 */
    }
  }
  return { ok: r.ok, message: r.message || '已停止模型服务' };
}

/** 模型服务状态：谁在跑、我们启的 pid 在不在、地址通不通。 */
export async function modelServiceStatus({ rootDir = ROOT, baseUrl = '' } = {}) {
  const runners = await detectLocalRunners({ rootDir });
  const pid = startedPid(rootDir);
  const alive = pid ? await isRunning(pid) : false;
  const target = baseUrl || (runners[0] ? runners[0].baseUrl : '');
  const probe = await probeModelService(target, 2000);
  return {
    runners,
    pid: alive ? pid : 0,
    startedByUs: alive,
    baseUrl: target,
    online: probe.ok,
    models: probe.models,
    error: probe.error || '',
  };
}

/** 默认给小白用的最小可用本地模型（中文友好、体积小，约 1GB）。 */
export const DEFAULT_MODEL = 'qwen2.5:1.5b';

/** 用 Node 内置 https 下载文件（无需第三方依赖），支持 30x 跳转。 */
export function downloadFile(url, dest, { timeoutMs = 180000 } = {}) {
  return new Promise((resolve, reject) => {
    const get = (u) => {
      const req = https.get(u, { headers: { 'User-Agent': 'AutoChat' } }, (res) => {
        const code = res.statusCode || 0;
        if (code >= 300 && code < 400 && res.headers.location) {
          res.resume();
          return get(res.headers.location);
        }
        if (code !== 200) {
          res.resume();
          return reject(new Error('下载失败，HTTP ' + code));
        }
        const file = fs.createWriteStream(dest);
        res.pipe(file);
        file.on('finish', () => file.close(() => resolve({ size: Number(res.headers['content-length']) || 0 })));
        file.on('error', (e) => {
          try {
            fs.unlinkSync(dest);
          } catch {
            /* 忽略 */
          }
          reject(e);
        });
      });
      req.on('timeout', () => req.destroy(new Error('下载超时')));
      req.setTimeout(timeoutMs);
      req.on('error', reject);
    };
    get(url);
  });
}

const OLLAMA_INSTALLER_URL = 'https://ollama.com/download/OllamaSetup.exe';

/**
 * 下载并安装 Ollama（Windows：拉官方安装包静默安装）。
 * 安全：只下载官方安装包并启动它，不替用户做任何越权操作。
 */
export async function installOllama({ rootDir = ROOT, timeoutMs = 180000 } = {}) {
  const existing = await detectLocalRunners({ rootDir, runnerId: 'ollama' });
  if (existing[0] && existing[0].installed) {
    return { ok: true, installed: true, message: 'Ollama 已经装好了' };
  }
  const tmp = path.join(os.tmpdir(), 'AutoChat-ollama-setup.exe');
  try {
    await downloadFile(OLLAMA_INSTALLER_URL, tmp, { timeoutMs });
  } catch (e) {
    return { ok: false, message: '下载 Ollama 安装包失败：' + e.message + '（可手动去 https://ollama.com/download 下载安装）' };
  }
  await new Promise((resolve) => {
    const child = spawn(tmp, ['/S'], { windowsHide: true, stdio: 'ignore' });
    child.on('exit', () => resolve());
    child.on('error', () => resolve());
  });
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    const r = await detectLocalRunners({ rootDir, runnerId: 'ollama' });
    if (r[0] && r[0].installed) {
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* 忽略 */
      }
      return { ok: true, installed: true, message: 'Ollama 安装完成' };
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  return {
    ok: false,
    message: '安装程序已启动，但还没检测到 ollama.exe。请手动完成安装后刷新（https://ollama.com/download）',
  };
}

/**
 * 拉取一个本地模型（默认 qwen2.5:1.5b，中文友好、体积小）。
 * 这一步要从模型源下载几百 MB～1GB，请保持联网。
 */
export async function pullModel({ rootDir = ROOT, model = DEFAULT_MODEL, timeoutMs = 600000 } = {}) {
  const runners = await detectLocalRunners({ rootDir, runnerId: 'ollama' });
  const r = runners[0];
  if (!r || !r.installed) return { ok: false, message: '本机还没装 Ollama，先安装' };
  const exe = r.exe || 'ollama';
  return new Promise((resolve) => {
    const child = spawn(exe, ['pull', model], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => {
      out += d;
    });
    child.stderr.on('data', (d) => {
      out += d;
    });
    const to = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* 忽略 */
      }
      resolve({ ok: false, message: '拉取超时（' + model + '），可在命令行手动 ollama pull ' + model });
    }, timeoutMs);
    child.on('exit', (code) => {
      clearTimeout(to);
      if (code === 0) {
        resolve({
          ok: true,
          model,
          message: '模型 ' + model + ' 已就绪（去「接一个模型」卡点保存即可生效）',
        });
      } else {
        resolve({ ok: false, message: '拉取失败（退出码 ' + code + '）：' + out.slice(-300) });
      }
    });
    child.on('error', (e) => {
      clearTimeout(to);
      resolve({ ok: false, message: '拉取出错：' + e.message });
    });
  });
}

/** 把本地 Ollama 写进 AI 配置（baseUrl / model / 启用），小白无需手填。 */
export async function configureLocalModel({ rootDir = ROOT, model = DEFAULT_MODEL } = {}) {
  writeEditableEnv(
    {
      AI_BASE_URL: 'http://127.0.0.1:11434/v1',
      AI_MODEL: model,
      AI_ENABLED: '1',
    },
    rootDir
  );
  return {
    ok: true,
    message: '已写入 AI 配置（本地 Ollama，' + model + '）。回「接一个模型」卡点保存并重启助手即可生效。',
  };
}
