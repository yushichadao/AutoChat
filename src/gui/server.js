import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { ROOT } from '../core/paths.js';
import { json, readBody } from './http.js';
import { openUi } from './browser.js';
import * as apiState from './api/state.js';
import * as apiAi from './api/ai.js';
import * as apiEnv from './api/env.js';
import * as apiChats from './api/chats.js';
import * as apiService from './api/service.js';
import * as apiInstall from './api/install.js';
import * as apiLogs from './api/logs.js';
import * as apiOnboard from './api/onboard.js';

/**
 * 图形化配置器的服务端（与命令行平级的另一套入口）。
 *
 * 职责边界：**只做 HTTP 收发、令牌校验与静态资源**；
 * 业务动作全在 src/tasks/，界面全在 src/gui/ui/。
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const UI_DIR = path.join(HERE, 'ui');

/** 旧引用兼容：白名单与脱敏现在住在任务层。 */
export { safeEnv, EDITABLE_ENV } from '../tasks/config.js';
export { CHAT_FIELDS } from '../core/chats.js';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
};

/** 所有接口路由（方法 + 路径 → 处理函数）。 */
const ROUTES = new Map();
for (const mod of [apiState, apiAi, apiEnv, apiChats, apiService, apiInstall, apiLogs, apiOnboard]) {
  for (const [key, fn] of Object.entries(mod.routes)) ROUTES.set(key, fn);
}

/** 把请求路径安全地映射到 ui 目录下的文件；越界一律拒绝。 */
export function resolveStatic(rel) {
  let decoded = rel;
  try {
    decoded = decodeURIComponent(rel);
  } catch {
    /* 非法编码就按原样处理 */
  }
  const full = path.resolve(UI_DIR, decoded);
  const base = path.resolve(UI_DIR);
  if (full !== base && !full.startsWith(base + path.sep)) return null;
  return full;
}

/** 启动图形化配置器。 */
export async function startGui({ rootDir = ROOT, port = 8788, window = false } = {}) {
  port = Number(port) || 8788; // 上游传 0 / NaN 时回退默认，避免 listen(0) 后 URL 写 0
  const dataDir = path.join(rootDir, 'data');
  const guiStateFile = path.join(dataDir, 'gui.json');
  const token = crypto.randomBytes(16).toString('hex');

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://' + (req.headers.host || '127.0.0.1'));
    const given = url.searchParams.get('token') || req.headers['x-autochat-token'];
    if (given !== token) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('令牌无效。请用命令行启动：autochat gui');
      return;
    }

    const key = req.method + ' ' + url.pathname;
    const fn = ROUTES.get(key);
    if (fn) {
      try {
        const out = await fn({ req, res, url, rootDir, body: () => readBody(req) });
        json(res, out.status || 200, out.body === undefined ? {} : out.body);
      } catch (err) {
        json(res, 500, { error: err.message });
      }
      return;
    }

    if (url.pathname.startsWith('/api/')) {
      json(res, 404, { error: 'not found' });
      return;
    }

    const rel = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/+/, '');
    const full = resolveStatic(rel);
    if (!full || !fs.existsSync(full) || !fs.statSync(full).isFile()) {
      res.writeHead(404);
      res.end('not found');
      return;
    }

    // 静态资源也要过令牌校验，所以 HTML 里的资源链接必须带上本次会话的令牌。
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
  // 复用已有服务、只把窗口重新打开；若是别的程序占的，明确提示换端口。
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
      const url = 'http://127.0.0.1:' + port + '/?token=' + prev.token;
      console.log('配置器已在运行，直接打开（不重复起服务）：' + url.replace(/token=[^&]+/i, 'token=***'));
      await openUi(url, true);
      return { url, token: prev.token, server: null, reused: true };
    }
    throw new Error('端口 ' + port + ' 已被其它程序占用。换个端口再启动：autochat gui --port 8789');
  }

  // 令牌落到 data/gui.json：重复启动时靠它认出「这是我们自己的配置器」并复用。
  const actualPort = server.address().port;
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(guiStateFile, JSON.stringify({ port: actualPort, token }, null, 2) + '\n', 'utf8');
  try {
    fs.chmodSync(guiStateFile, 0o600);
  } catch {
    /* 非 POSIX 权限模型（如 Windows）可忽略 */
  }

  const url = 'http://127.0.0.1:' + actualPort + '/?token=' + token;
  console.log('AutoChat 配置器已启动：' + url.replace(/token=[^&]+/i, 'token=***') + '（完整带令牌链接已用于本机自动打开）');
  console.log('关掉这个窗口就等于停掉配置器（不影响正在运行的助手服务）');
  await openUi(url, window);

  return { url, token, server };
}
