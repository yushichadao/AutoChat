import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * AutoChat 插件：与 AutoChat 本体对话的那一层。
 *
 * 职责边界（刻意保持，改动前先想清楚）：
 *   **不重新实现任何配置逻辑**。判定与落盘全在 AutoChat 的 `src/tasks/` 里，
 *   这里只把动作翻译成一次 `autochat` CLI 调用，并把终端输出整理成能读的文本。
 *   这样命令行、图形化配置器、DSH 插件、MCP 服务器四处永远说同一句话。
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** 插件包根目录（plugin/dsh-autochat）。 */
const BUNDLE_ROOT = path.resolve(HERE, '..', '..');
const CLI_REL = path.join('src', 'cli', 'index.js');

/** 是不是一份完整的 AutoChat（有 CLI 入口）。 */
export function isAutoChatRoot(dir) {
  return Boolean(dir) && fs.existsSync(path.join(dir, CLI_REL));
}

/**
 * 找出这次要操作的 AutoChat 安装目录。
 *
 * 顺序：
 *   1. 显式传入（DSH 的插件配置 / 未来的命令行参数）
 *   2. 环境变量 AUTOCHAT_HOME
 *   3. 从插件包目录往上找（本地目录安装时链接回仓库，能直接认出仓库根）
 *   4. 常见安装位置（用户目录下的 AutoChat、CodeBuddy\AutoChat 等）
 *
 * 认不出就返回空 —— 工具会明确告诉用户「没找到 AutoChat，怎么指定」，
 * 而不是拿一个猜出来的目录去改配置。
 */
export function resolveHome(explicit) {
  const tries = [];
  if (explicit) tries.push({ source: 'config', dir: path.resolve(explicit) });
  if (process.env.AUTOCHAT_HOME) {
    tries.push({ source: 'AUTOCHAT_HOME', dir: path.resolve(process.env.AUTOCHAT_HOME) });
  }

  let cur = BUNDLE_ROOT;
  for (let i = 0; i < 6; i += 1) {
    tries.push({ source: 'bundle-walkup', dir: cur });
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }

  const userHome = process.env.USERPROFILE || process.env.HOME || '';
  if (userHome) {
    tries.push({ source: 'common', dir: path.join(userHome, 'CodeBuddy', 'AutoChat') });
    tries.push({ source: 'common', dir: path.join(userHome, 'AutoChat') });
  }
  if (process.env.LOCALAPPDATA) {
    tries.push({ source: 'common', dir: path.join(process.env.LOCALAPPDATA, 'AutoChat') });
  }

  for (const t of tries) {
    if (isAutoChatRoot(t.dir)) return { home: t.dir, source: t.source };
  }
  return { home: '', source: 'none' };
}

let CURRENT = resolveHome();

/** 设定当前操作的 AutoChat 目录（DSH 插件按配置调用；MCP 服务器用默认值）。 */
export function setHome(explicit) {
  CURRENT = explicit ? resolveHome(explicit) : resolveHome();
  return CURRENT;
}

/** 当前操作的 AutoChat 目录与它的来源。 */
export function getHome() {
  return { ...CURRENT };
}

/** 没找到 AutoChat 时的统一提示。 */
export function missingHomeHint() {
  return (
    '没有找到 AutoChat 的安装目录（需要一个含 src/cli/index.js 的目录）。\n' +
    '三种指定方式，任选其一：\n' +
    '  ① 设环境变量 AUTOCHAT_HOME=C:\\path\\to\\AutoChat\n' +
    '  ② 在 DSH 的插件配置里给本插件填 home（cordis.patch.yml 的 config.home）\n' +
    '  ③ 把插件装在 AutoChat 仓库里（本地目录安装），插件会自己认出仓库根'
  );
}

/**
 * 跑一次 CLI。
 *
 * 走 CLI 而不是直接 import 内部模块：这样插件永远跟着用户手上那套 AutoChat 走
 * （同一个入口、同一份判断、同一个退出码约定：0 正常 / 1 出错 / 2 体检有阻断项）。
 *
 * @param {string[]} args autochat 之后的参数（不含 node 与脚本路径）
 * @param {{timeoutMs?: number}} opts
 */
export function runCli(args, { timeoutMs = 30000 } = {}) {
  const { home } = CURRENT;
  return new Promise((resolve) => {
    if (!isAutoChatRoot(home)) {
      resolve({ code: null, out: '', err: missingHomeHint(), timedOut: false });
      return;
    }
    let child;
    try {
      child = spawn(process.execPath, [path.join(home, CLI_REL), ...args], {
        cwd: home,
        windowsHide: true,
        env: { ...process.env, NO_COLOR: '1' },
      });
    } catch (err) {
      resolve({ code: null, out: '', err: err.message, timedOut: false });
      return;
    }

    let out = '';
    let err = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill();
      } catch {
        /* 已经退了 */
      }
    }, timeoutMs);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c) => {
      out += c;
    });
    child.stderr.on('data', (c) => {
      err += c;
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: null, out, err: err + '\n' + e.message, timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, out, err, timedOut });
    });
  });
}

/** 从一段输出里尽力抠出 JSON。 */
export function parseJson(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    /* 继续尝试从中间截 */
  }
  const i = raw.indexOf('{');
  const j = raw.lastIndexOf('}');
  if (i >= 0 && j > i) {
    try {
      return JSON.parse(raw.slice(i, j + 1));
    } catch {
      return null;
    }
  }
  return null;
}

/** 跑一次 CLI 并解析 JSON；解析不出来就把原始输出带回去。 */
export async function runJson(args, opts) {
  const r = await runCli(args, opts);
  return { ...r, data: parseJson(r.out) };
}

/* ------------------------------------------------------------------ *
 * 根本性配置的门槛
 * ------------------------------------------------------------------ */

/** 会把「配置没走完」误当成「配好了」的动作，各自需要哪些步骤不能是阻断态。 */
export const GATES = {
  'service.start': { steps: ['node', 'wechat', 'dll', 'model'], label: '启动助手服务' },
  'gate.resume': { steps: ['node', 'wechat', 'dll', 'model'], label: '恢复自动回复' },
  'step.deploy-dll': { steps: ['wechat'], label: '把 hook DLL 写进微信目录' },
  'step.fix-dll': { steps: ['wechat'], label: '换成匹配的 hook DLL' },
  'step.detect-dll': { steps: ['node'], label: '自动匹配 hook DLL' },
};

/** 读一遍初始化七步的现状（--non-interactive：只体检，绝不自动改任何东西）。 */
export async function readPreflight() {
  const r = await runJson(['setup', '--json', '--non-interactive'], { timeoutMs: 45000 });
  const data = r.data || { steps: [], summary: null };
  const steps = Array.isArray(data.steps) ? data.steps : [];
  return {
    steps,
    byId: new Map(steps.map((s) => [s.id, s])),
    summary: data.summary || summarizeFallback(steps),
    raw: r.out.trim() || r.err.trim(),
    code: r.code,
  };
}

export function summarizeFallback(steps) {
  const bad = steps.filter((s) => s.level === 'bad').length;
  const warn = steps.filter((s) => s.level === 'warn').length;
  return { total: steps.length, bad, warn, done: steps.length - bad - warn, ready: bad === 0 };
}

/**
 * 检查某个动作的门槛。
 * @returns {{blocked: Array<object>, warned: Array<object>, summary: object}}
 */
export function checkGate(pre, action) {
  const g = GATES[action];
  if (!g) return { blocked: [], warned: [], summary: pre.summary };
  const blocked = [];
  const warned = [];
  for (const id of g.steps) {
    const s = pre.byId.get(id);
    if (!s) continue;
    if (s.level === 'bad') blocked.push(s);
    else if (s.level === 'warn') warned.push(s);
  }
  return { blocked, warned, summary: pre.summary };
}

export const ICON = { ok: '✓', warn: '!', bad: '✗', todo: '·' };

/** 把七步渲染成一段人也能读的清单。 */
export function renderSteps(steps, summary) {
  const s = summary || summarizeFallback(steps);
  const lines = [
    `根本性配置 ${s.done}/${s.total} 就绪 · 阻断 ${s.bad} · 提醒 ${s.warn} · ` +
      (s.bad ? '**还不能算配好**' : '可以启动'),
  ];
  steps.forEach((st, i) => {
    lines.push(`${i + 1}. ${ICON[st.level] || '·'} ${st.title}：${st.detail || ''}`);
    if (st.next) lines.push(`   → ${st.next}`);
  });
  return lines.join('\n');
}
