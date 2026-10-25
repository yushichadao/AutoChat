import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { ROOT, loadConfig } from '../config.js';
import { MasterSwitch, PidFile } from '../bridge/switch.js';
import { readEnvFile, setEnvValues } from '../cli/env-file.js';
import { diagnose } from './diagnose.js';
import { groupedProviders } from '../ai/providers.js';
import { listModels, testChat, discoverLocal, reviewConfig } from '../ai/probe.js';
import { install, uninstall, installStatus, lockWeChatUpdate, resolveBuiltinDll } from './installer.js';
import { detectWeChat } from '../bridge/process.js';
import { isRunning, killProcess, ps, wmiCreate } from './win.js';
import { spawn, spawnSync } from 'node:child_process';
import { HookClient } from '../bridge/hook-client.js';
import { ContactCache } from '../bridge/contacts.js';

/**
 * 图形化配置器的后端。
 *
 * 起一个只监听回环地址的本地 HTTP 服务，浏览器打开就是配置界面。
 * 不用 Electron：零依赖是本项目的硬约束（CI 会检查），
 * 一个本地 HTTP 服务 + 一张单页，Windows / macOS / Linux 都能跑，
 * 想做成桌面窗口再套一层系统 WebView 就行（见 gui-window.ps1）。
 *
 * 安全：随机会话令牌。本机任何网页都能向 127.0.0.1 发请求，
 * 没有令牌的话，一个恶意网页就能改你的配置、打开自动回复 —— 所以必须带令牌。
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const UI_DIR = path.join(HERE, 'ui');

/** 回传前端前的 .env 脱敏：密钥类只保留「是否已配置」布尔，杜绝真实密钥进入浏览器 DOM。 */
const SENSITIVE_ENV = new Set(['AI_API_KEY', 'WX_WEBHOOK_TOKEN']);
export function safeEnv(env) {
  const out = {};
  for (const [k, v] of Object.entries(env || {})) out[k] = SENSITIVE_ENV.has(k) ? Boolean(v) : v;
  return out;
}
/** 打印日志时把 URL 里的令牌脱敏，避免令牌出现在终端/日志里。 */
const maskToken = (u) => String(u).replace(/token=[^&]+/i, 'token=***');

/** 只允许 GUI 改的 .env 键（避免手滑写坏别的） */
export const EDITABLE_ENV = new Set([
  'AI_ENABLED', 'AI_MASTER_SWITCH', 'AI_BASE_URL', 'AI_API_KEY', 'AI_MODEL',
  'AI_TIMEOUT_MS', 'AI_MAX_TOKENS', 'AI_TEMPERATURE', 'AI_CONTEXT_TURNS',
  'AI_CONTEXT_TTL_MS', 'AI_CONTEXT_MAX_CHARS', 'AI_COOLDOWN_MS', 'AI_MAX_PER_HOUR',
  'AI_MAX_CONCURRENT', 'AI_GROUP_REPLY', 'AI_TRIGGER_PREFIX', 'AI_GROUP_AT_NAMES',
  'AI_ALLOW_CHATS', 'AI_DENY_CHATS', 'AI_MAX_REPLY_CHARS', 'AI_STRIP_MARKDOWN', 'AI_PERSONA_FILE',
  'AI_SYSTEM_PROMPT', 'WX_SELF_ID', 'WX_SELF_MODE', 'WX_RECEIVE_MODE',
  'WX_POLL_CHATS', 'WX_POLL_DB', 'WX_POLL_LIMIT', 'WX_POLL_INTERVAL_MS',
  'WX_INJECT_MODE', 'WX_DLL_PATH', 'WX_INSTALL_DIR', 'WX_HOOK_PORT',
  'WX_WEBHOOK_PORT', 'WX_WEBHOOK_TOKEN', 'LOG_LEVEL',
]);

/** /api/chats 允许写入的字段（防御越权写入 apiKey 等敏感键）。 */
export const CHAT_FIELDS = new Set([
  'enabled', 'groupReply', 'personaFile', 'model', 'baseUrl', 'systemPrompt', 'triggerPrefix',
]);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

export function json(res, code, body) {
  const text = JSON.stringify(body);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
  });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      try {
        resolve(text ? JSON.parse(text) : {});
      } catch {
        resolve({});
      }
    });
  });
}

export const envFile = (rootDir) => path.join(rootDir, '.env');
export const jsonFile = (rootDir) => path.join(rootDir, 'config.json');

export function readChats(rootDir) {
  const file = jsonFile(rootDir);
  if (!fs.existsSync(file)) return {};
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')).chats || {};
  } catch {
    return {};
  }
}

export function writeChats(rootDir, chats) {
  const file = jsonFile(rootDir);
  let raw = {};
  if (fs.existsSync(file)) {
    try {
      raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      raw = {};
    }
  }
  raw.chats = chats || {};
  fs.writeFileSync(file, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');
}

/** 复用同一个 hook + 通讯录缓存，避免每次刷新都重建。 */
let _hook = null;
let _contacts = null;
let _hookKey = '';
function getHookContacts(rootDir) {
  const cfg = loadConfig({ rootDir });
  const key = `${cfg.wechat.host}:${cfg.wechat.port}`;
  if (_hook && _hookKey === key) return { hook: _hook, contacts: _contacts };
  _hook = new HookClient({
    host: cfg.wechat.host,
    port: cfg.wechat.port,
    endpoints: cfg.wechat.endpoints,
    dbQueryTimeoutMs: 3000,
  });
  _contacts = new ContactCache({ hook: _hook });
  _hookKey = key;
  return { hook: _hook, contacts: _contacts };
}

/** 给会话附上汉字名（群名 / 昵称）。需要微信 hook 可达；查不到就留空，不影响主流程。
 *  memory 是数组（上下文记忆），chats 是对象（按会话差异化配置，键即 chatId）。 */
async function attachContactNames(rootDir, memory, chats) {
  const ids = [
    ...(memory || []).map((m) => m.chatId),
    ...Object.keys(chats || {}),
  ].filter(Boolean);
  if (!ids.length) return;
  try {
    const { hook, contacts } = getHookContacts(rootDir);
    const st = await hook.ping().catch(() => ({ ok: false }));
    if (!st.ok) return; // hook 没起来（微信没跑 / DLL 没注入），跳过
    await contacts.lookup(ids);
    const nameFor = (id) => contacts.nameOf(id) || '';
    for (const m of memory || []) {
      const nm = nameFor(m.chatId);
      if (nm) m.name = nm;
    }
    for (const [id, c] of Object.entries(chats || {})) {
      const nm = nameFor(id);
      if (nm) c.name = nm;
    }
  } catch {
    /* 查联系人失败不影响状态快照 */
  }
}

/** 微信 update 目录是否被替换成只读文件（锁版本标志）。 */
async function isVersionLocked() {
  const up = path.join(process.env.APPDATA || '', 'Tencent', 'xwechat', 'update');
  if (!fs.existsSync(up)) return false;
  const { out } = await ps(`(Get-Item -LiteralPath '${String(up).replace(/'/g, "''")}' -ErrorAction SilentlyContinue).IsReadOnly`);
  return String(out).trim() === 'True';
}

/** 统一给界面用的状态快照。 */
export async function buildState(rootDir) {
  const cfg = loadConfig({ rootDir });
  const sw = new MasterSwitch({ file: path.join(cfg.dataDir, 'paused') });
  const pid = new PidFile({ file: path.join(cfg.dataDir, 'autochat.pid') }).read();
  const inst = await installStatus({ rootDir });
  const wechat = await detectWeChat('').catch(() => null);

  let memory = [];
  const memFile = path.join(cfg.dataDir, 'ai-memory.json');
  if (fs.existsSync(memFile)) {
    try {
      const raw = JSON.parse(fs.readFileSync(memFile, 'utf8'));
      const bag = raw.sessions || raw;
      memory = Object.entries(bag)
        .filter(([k]) => k !== '__v')
        .map(([id, s]) => ({
          chatId: id,
          messages: (s.messages || []).length,
          updatedAt: s.updatedAt || 0,
          last: (s.messages || []).slice(-4).map((m) => ({
            role: m.role,
            content: String(m.content).slice(0, 120),
          })),
        }));
    } catch {
      memory = [];
    }
  }

  const chats = readChats(rootDir);
  // 按会话 apiKey 属敏感信息，回传前端前剔除，避免进入浏览器 DOM
  for (const c of Object.values(chats)) {
    if (c && typeof c === 'object') delete c.apiKey;
  }
  await attachContactNames(rootDir, memory, chats);

  return {
    rootDir,
    running: pid ? await isRunning(pid) : false,
    pid,
    gate: sw.status(),
    installed: inst,
    autoStart: inst.autoStart,
    env: safeEnv(readEnvFile(envFile(rootDir))),
    chats,
    memory,
    config: {
      ai: {
        enabled: cfg.ai.enabled,
        masterSwitch: cfg.ai.masterSwitch,
        baseUrl: cfg.ai.baseUrl,
        model: cfg.ai.model,
        personaFile: cfg.ai.personaFile,
        groupReply: cfg.ai.groupReply,
        contextTurns: cfg.ai.contextTurns,
        contextTtlMs: cfg.ai.contextTtlMs,
        contextMaxChars: cfg.ai.contextMaxChars,
        maxPerHour: cfg.ai.maxPerHour,
        cooldownMs: cfg.ai.cooldownMs,
      },
      wechat: {
        selfId: cfg.wechat.selfId,
        selfMode: cfg.wechat.selfMode,
        receiveMode: cfg.wechat.receiveMode,
        pollChats: cfg.wechat.pollChats,
        dllPath: cfg.wechat.dllPath,
        installDir: cfg.wechat.installDir,
      },
    },
    wechatVersion: wechat?.version || null,
    versionLocked: await isVersionLocked(),
  };
}

/** 日志太大就滚一代，避免 data/ 越滚越大。 */
function rotateLog(file, maxBytes = 2 * 1024 * 1024) {
  try {
    if (!fs.existsSync(file)) return;
    if (fs.statSync(file).size <= maxBytes) return;
    const old = `${file}.1`;
    try {
      fs.unlinkSync(old);
    } catch {
      /* 没有旧的就忽略 */
    }
    fs.renameSync(file, old);
  } catch {
    /* 滚不动就算了 */
  }
}

/** 启动后台服务进程（图形界面里的「启动」按钮）。 */
export async function startService(rootDir) {
  const dataDir = path.join(rootDir, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const entry = path.join(rootDir, 'src', 'index.js');
  const logOut = path.join(dataDir, 'autochat.out');
  const logErr = path.join(dataDir, 'autochat.err');
  const q = (s) => String(s).replace(/"/g, '""');

  rotateLog(logOut);
  rotateLog(logErr);

  // 首选 WMI：进程归 WMI 管，不在调用方的进程作业里，
  // 关掉配置器窗口、关掉终端都不会把服务带走。日志用 cmd 追加，不覆盖。
  const cmdLine =
    `cmd.exe /c cd /d "${q(rootDir)}" && "${q(process.execPath)}" "${q(entry)}" ` +
    `>> "${q(logOut)}" 2>> "${q(logErr)}"`;
  const wmi = await wmiCreate(cmdLine);
  if (wmi.ok) return { ok: true, pid: 0, method: 'wmi', message: '' };

  // 回退：PowerShell 的 Start-Process（也能跑，只是可能被父进程带走）
  const script = [
    `$p = Start-Process -FilePath "${q(process.execPath)}" -ArgumentList @("${q(entry)}")`,
    `-WorkingDirectory "${q(rootDir)}" -RedirectStandardOutput "${q(logOut)}" -RedirectStandardError "${q(logErr)}"`,
    '-WindowStyle Hidden -PassThru;',
    'Write-Output $p.Id',
  ].join(' ');

  const { ok, out, err } = await ps(script);
  const pid = Number(String(out).split(/\s+/).pop()) || 0;
  return { ok: ok && pid > 0, pid, method: 'start-process', message: err || '' };
}

/** 处理一个 API 请求。 */
async function handleApi(req, res, url, rootDir) {
  const p = url.pathname;

  if (p === '/api/state') return json(res, 200, await buildState(rootDir));

  // ── 模型接入：预设表 / 本机发现 / 拉模型 / 试聊 ─────────────────────────
  if (p === '/api/ai/providers') {
    return json(res, 200, { groups: groupedProviders() });
  }

  if (p === '/api/ai/discover') {
    const found = await discoverLocal();
    return json(res, 200, { found });
  }

  if (p === '/api/ai/models' && req.method === 'POST') {
    const body = await readBody(req);
    const r = await listModels({ baseUrl: body.base, apiKey: body.key || '' });
    return json(res, 200, r);
  }

  if (p === '/api/ai/review' && req.method === 'POST') {
    const body = await readBody(req);
    return json(res, 200, { tips: reviewConfig({ baseUrl: body.base, apiKey: body.key, model: body.model }) });
  }

  if (p === '/api/ai/test' && req.method === 'POST') {
    const body = await readBody(req);
    const r = await testChat({
      baseUrl: body.base,
      apiKey: body.key || '',
      model: body.model,
      timeoutMs: Number(body.timeoutMs) || 20000,
    });
    return json(res, 200, r);
  }

  if (p === '/api/diagnose') return json(res, 200, await diagnose({ rootDir }));

  if (p === '/api/gate' && req.method === 'POST') {
    const body = await readBody(req);
    const sw = new MasterSwitch({ file: path.join(loadConfig({ rootDir }).dataDir, 'paused') });
    const r = body.paused
      ? sw.pause(body.reason || '图形化配置器暂停')
      : sw.resume();
    return json(res, 200, { ...r, gate: sw.status() });
  }

  if (p === '/api/env' && req.method === 'POST') {
    const body = await readBody(req);
    const updates = {};
    for (const [k, v] of Object.entries(body.values || {})) {
      if (!EDITABLE_ENV.has(k)) continue;
      updates[k] = v === null ? null : String(v);
    }
    const r = setEnvValues(envFile(rootDir), updates);
    return json(res, 200, { ok: true, changed: r.changed, state: await buildState(rootDir) });
  }

  // ── 锁住微信版本（阻断自动更新）──
  if (p === '/api/lock' && req.method === 'POST') {
    const r = await lockWeChatUpdate();
    return json(res, 200, { ...r, state: await buildState(rootDir) });
  }

  // ── 按微信版本自动选内置 DLL ──
  if (p === '/api/autodll' && req.method === 'POST') {
    const wechat = await detectWeChat('').catch(() => null);
    const builtin = wechat?.version ? resolveBuiltinDll(wechat.version, rootDir) : null;
    return json(res, 200, { version: wechat?.version || null, path: builtin, state: await buildState(rootDir) });
  }

  if (p === '/api/chats' && req.method === 'POST') {
    const body = await readBody(req);
    const chats = readChats(rootDir);
    for (const [id, c] of Object.entries(body.chats || {})) {
      const clean = {};
      if (c && typeof c === 'object') {
        for (const k of CHAT_FIELDS) if (k in c) clean[k] = c[k];
      } else {
        clean.enabled = true;
      }
      chats[id] = clean;
    }
    for (const id of body.remove || []) delete chats[id];
    writeChats(rootDir, chats);
    return json(res, 200, { ok: true, chats, state: await buildState(rootDir) });
  }

  // 文件上传到工作区 data/：GUI 用原生文件选择器选文件后调这里，避免手填路径。
  // 防穿越：文件名只取 basename，禁止任何路径分隔与 . 开头的隐藏文件。
  if (p === '/api/file/upload' && req.method === 'POST') {
    const body = await readBody(req);
    const name = String(body.name || '').trim();
    const content = String(body.content || '');
    const safe = path.basename(name).replace(/[\/\\]/g, '');
    if (!safe || safe !== name || safe === '.' || safe === '..' || safe.startsWith('.')) {
      return json(res, 400, { error: '非法文件名' });
    }
    const dir = path.join(rootDir, 'data');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, safe), content, 'utf8');
    return json(res, 200, { ok: true, path: `./data/${safe}` });
  }

  // 关键字搜索联系人（群名 / 昵称 / 备注 / 微信号），从微信通讯录库模糊匹配
  if (p === '/api/contacts/search') {
    const q = url.searchParams.get('q') || '';
    try {
      const { hook, contacts } = getHookContacts(rootDir);
      const st = await hook.ping().catch(() => ({ ok: false }));
      if (!st.ok) return json(res, 200, { ok: false, reason: 'hook 不可达（微信没运行或 DLL 未注入）', results: [] });
      const results = await contacts.search(q);
      return json(res, 200, { ok: true, results });
    } catch {
      return json(res, 200, { ok: false, results: [] });
    }
  }

  if (p === '/api/context/clear' && req.method === 'POST') {
    const body = await readBody(req);
    const file = path.join(loadConfig({ rootDir }).dataDir, 'ai-memory.json');
    let raw = { __v: 1, sessions: {} };
    if (fs.existsSync(file)) {
      try {
        raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch {
        /* 坏文件就当空 */
      }
    }
    const bag = raw.sessions || {};
    if (body.chatId) delete bag[body.chatId];
    else for (const k of Object.keys(bag)) delete bag[k];
    fs.writeFileSync(file, JSON.stringify({ __v: 1, sessions: bag }, null, 2), 'utf8');
    return json(res, 200, { ok: true, state: await buildState(rootDir) });
  }

  if (p === '/api/service' && req.method === 'POST') {
    const body = await readBody(req);
    const pidFile = new PidFile({ file: path.join(loadConfig({ rootDir }).dataDir, 'autochat.pid') });
    if (body.action === 'stop') {
      const pid = pidFile.read();
      const r = pid && (await isRunning(pid)) ? await killProcess(pid) : { ok: true };
      if (r.ok) pidFile.clear();
      return json(res, 200, { ok: r.ok, message: r.message || '已停止', state: await buildState(rootDir) });
    }
    if (body.action === 'start') {
      // 已经有活着的实例就别再起一个：两个助手会对着同一个群重复回复
      const cur = pidFile.read();
      if (cur && (await isRunning(cur))) {
        return json(res, 200, {
          ok: true,
          message: `服务已在运行（pid ${cur}）`,
          state: await buildState(rootDir),
        });
      }
      const started = await startService(rootDir);
      // 等服务真正起来（写入 pid 文件）再回包，否则界面会显示「未运行」
      const deadline = Date.now() + 12000;
      let state = await buildState(rootDir);
      while (!state.running && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 500));
        state = await buildState(rootDir);
      }
      return json(res, 200, { ok: started.ok && state.running, message: started.message, state });
    }
  }

  if (p === '/api/install' && req.method === 'POST') {
    const body = await readBody(req);
    const r = await install({
      rootDir,
      env: body.env || {},
      chats: body.chats || {},
      autostart: Boolean(body.autostart),
      shortcut: Boolean(body.shortcut),
      deployDll: Boolean(body.deployDll),
    });
    return json(res, 200, { ...r, state: await buildState(rootDir) });
  }

  if (p === '/api/uninstall' && req.method === 'POST') {
    const body = await readBody(req);
    const r = await uninstall({ rootDir, purge: Boolean(body.purge) });
    return json(res, 200, { ...r, state: await buildState(rootDir) });
  }

  return json(res, 404, { error: 'not found' });
}

/**
 * 探测一个可用的浏览器可执行文件（优先 Edge / Chrome / Chromium），
 * 用于「单开独立浏览器窗口」而不是污染用户的默认浏览器。
 */
function findBrowser() {
  const which = (cmd) => {
    try {
      const r = spawnSync('where', [cmd], { windowsHide: true }).stdout?.toString().trim().split(/\r?\n/)[0];
      return r && fs.existsSync(r) ? r : null;
    } catch { return null; }
  };
  const exists = (p) => (fs.existsSync(p) ? p : null);
  if (process.platform === 'win32') {
    const list = [
      () => which('msedge'),
      () => which('chrome'),
      () => which('chromium'),
      () => exists('C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'),
      () => exists('C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'),
      () => exists('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'),
      () => exists('C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'),
    ];
    for (const f of list) { const r = f(); if (r) return r; }
    return null;
  }
  if (process.platform === 'darwin') {
    for (const p of [
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    ]) { const r = exists(p); if (r) return r; }
    return null;
  }
  for (const c of ['google-chrome', 'chromium', 'chromium-browser', 'chrome']) { const r = which(c); if (r) return r; }
  return null;
}

/**
 * 打开配置器界面。
 * 关键 UX：永远用「固定的浏览器 + 独立的用户数据目录」单开一个独立窗口（--new-window），
 * 不会在用户正在用的默认浏览器里新建选项卡，也不会跨浏览器乱开。
 * 若探测不到具体浏览器，回退到系统默认打开（此时无法保证单开）。
 */
function openUi(url, windowMode) {
  if (!windowMode) return false;
  const profile = path.join(ROOT, 'data', 'gui-browser'); // 独立 profile，与用户日常浏览器完全隔离
  const exe = findBrowser();
  if (exe) {
    try {
      const child = spawn(
        exe,
        ['--new-window', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', url],
        { detached: true, stdio: 'ignore', windowsHide: true }
      );
      child.unref();
      return true;
    } catch { /* 落到回退 */ }
  }
  const opener = process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  const child = spawn(opener, args, { detached: true, stdio: 'ignore' });
  child.unref();
  return true;
}

/** 启动图形化配置器。 */
export async function startGui({ rootDir = ROOT, port = 8788, window = false } = {}) {
  port = Number(port) || 8788; // 防御：上游未传 / 传 0 / NaN 时回退默认，避免 listen(0) 后 URL 仍写 0（浏览器 ERR_UNSAFE_PORT）
  const dataDir = path.join(rootDir, 'data');
  const guiStateFile = path.join(dataDir, 'gui.json');
  const token = crypto.randomBytes(16).toString('hex');
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
    const given = url.searchParams.get('token') || req.headers['x-autochat-token'];
    if (given !== token) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('令牌无效。请用命令行启动：autochat gui');
      return;
    }

    if (url.pathname.startsWith('/api/')) {
      try {
        await handleApi(req, res, url, rootDir);
      } catch (err) {
        json(res, 500, { error: err.message });
      }
      return;
    }

    const rel = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/+/, '');
    const full = path.join(UI_DIR, rel);
    if (!full.startsWith(UI_DIR) || !fs.existsSync(full)) {
      res.writeHead(404);
      res.end('not found');
      return;
    }

    // 静态资源也走令牌校验，所以 HTML 里的资源链接必须带上本次会话的令牌。
    // 占位符在服务端替换，浏览器拿到的就是当前这次启动的真实令牌。
    const ext = path.extname(full);
    let body = fs.readFileSync(full);
    if (ext === '.html') {
      body = Buffer.from(body.toString('utf8').split('__AUTOMAT_TOKEN__').join(token), 'utf8');
    }
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': body.length,
      'Cache-Control': 'no-store',
    });
    res.end(body);
  });

  // 多开保护：端口被占时不再硬崩。若是我们自己的配置器（令牌记录还在），
  // 复用已有服务、只把窗口重新打开（ps1 会先关掉遗留的旧窗口）；
  // 若是别的程序占的，明确提示换端口。
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', resolve);
    });
  } catch {
    server.close();
    let prev = null;
    try {
      prev = JSON.parse(fs.readFileSync(guiStateFile, 'utf8'));
    } catch {
      /* 没有记录 */
    }
    if (prev && prev.port === port && prev.token) {
      const url = `http://127.0.0.1:${port}/?token=${prev.token}`;
      console.log(`配置器已在运行，直接打开（不重复起服务）：${maskToken(url)}`);
      await openUi(url, true); // 复用旧实例：端口被自己占用就打开旧的，不新起服务
      return { url, token: prev.token, server: null, reused: true };
    }
    throw new Error(`端口 ${port} 已被其它程序占用。换个端口再启动：autochat gui --port 8789`);
    }

    // 令牌落到 data/gui.json：重复启动时靠它认出「这是我们自己的配置器」并复用。
    // 该文件含会话令牌，限制为仅当前用户可读写。
    const actualPort = server.address().port; // 用 listen 后真实分配的端口，绝不可能是 0
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(guiStateFile, `${JSON.stringify({ port: actualPort, token }, null, 2)}\n`, 'utf8');
    try { fs.chmodSync(guiStateFile, 0o600); } catch { /* 非 POSIX 权限模型（如 Windows）可忽略 */ }

    const url = `http://127.0.0.1:${actualPort}/?token=${token}`;
    console.log(`AutoChat 配置器已启动：${maskToken(url)}（完整带令牌链接已用于本机自动打开）`);
    console.log('关掉这个窗口就等于停掉配置器（不影响正在运行的助手）');
    await openUi(url, window);

    return { url, token, server };
}
