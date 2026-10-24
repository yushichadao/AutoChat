/**
 * 一键演示：不需要 hook DLL、不需要真微信、不需要 API Key。
 * 起假的微信 hook + 假的 OpenAI 服务，跑通「微信来消息 → 模型回复 → 发回微信」。
 *
 *   npm run demo
 *
 * 所有服务都用随机端口，避免和本机已有服务（含残留进程）冲突。
 */
import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const children = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function log(icon, text) {
  console.log(`  ${icon}  ${text}`);
}

function start(args, env = {}, label = '') {
  const child = spawn(process.execPath, args, {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  child.stdout.on('data', (d) => {
    for (const line of String(d).split('\n')) {
      const t = line.trim();
      if (t) console.log(`  ${label} │ ${t}`);
    }
  });
  child.stderr.on('data', (d) => {
    for (const line of String(d).split('\n')) {
      const t = line.trim();
      if (t) console.log(`  ${label} ! ${t}`);
    }
  });
  children.push(child);
  return child;
}

function waitPort(port, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = () => {
      const s = net.connect({ host: '127.0.0.1', port }, () => {
        s.destroy();
        resolve();
      });
      s.on('error', () => {
        s.destroy();
        if (Date.now() > deadline) reject(new Error(`端口 ${port} 未就绪`));
        else setTimeout(tick, 200);
      });
    };
    tick();
  });
}

async function postJson(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  return res.json();
}

const getJson = async (url) => (await fetch(url)).json();

async function waitFor(fn, timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) return null;
    await sleep(200);
  }
}

function cleanup() {
  for (const c of children) {
    if (!c?.pid) continue;
    try {
      spawnSync('taskkill', ['/pid', String(c.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    } catch {
      c.kill();
    }
  }
  children.length = 0;
}

/** 起一个随机端口的子进程，等它打印 PORT=xxx。 */
function startWithPort(args, env = {}, label = '') {
  return new Promise((resolve, reject) => {
    const child = start(args, env, label);
    let buf = '';
    const timer = setTimeout(() => reject(new Error(`${label} 未在 15s 内打印端口`)), 15000);
    const onData = (d) => {
      buf += String(d);
      const m = /PORT=(\d+)/.exec(buf);
      if (m) {
        clearTimeout(timer);
        resolve({ child, port: Number(m[1]) });
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`${label} 启动失败（code=${code}）`));
    });
  });
}

/** 拿一个空闲端口。 */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'autochat-demo-'));
  const cfgFile = path.join(tmp, 'config.json');
  fs.writeFileSync(cfgFile, JSON.stringify({ chats: {} }));

  console.log('\n=== AutoChat 演示（无需 DLL / 无需 API Key）===\n');

  const WEBHOOK_PORT = await freePort();

  log('▶', '启动假微信 hook（模拟 DLL）');
  const hook = await startWithPort(
    ['tools/mock-hook.js', '--port', '0', '--webhook', `http://127.0.0.1:${WEBHOOK_PORT}/wechat`],
    {},
    'hook'
  );
  const HOOK_PORT = hook.port;

  log('▶', '启动假模型服务（模拟 hy3）');
  const aiSrv = await startWithPort(['tools/mock-ai.js', '--port', '0'], {}, ' ai ');
  const AI_PORT = aiSrv.port;

  log('▶', '启动助手（跳过注入、开启 AI）');
  start(
    ['src/index.js'],
    {
      WX_SKIP_INJECT: '1',
      WX_HOOK_PORT: String(HOOK_PORT),
      WX_WEBHOOK_PORT: String(WEBHOOK_PORT),
      WX_RECEIVE_MODE: 'webhook',
      WX_CONFIG_FILE: cfgFile,
      WX_ENV_FILE: path.join(tmp, 'no.env'),
      WX_DATA_DIR: tmp,
      AI_ENABLED: '1',
      AI_BASE_URL: `http://127.0.0.1:${AI_PORT}/v1`,
      AI_API_KEY: 'demo',
      AI_MODEL: 'hy3',
      AI_COOLDOWN_MS: '0',
      LOG_LEVEL: 'info',
    },
    'main'
  );
  await waitPort(WEBHOOK_PORT, 20000);
  await sleep(400);

  console.log('\n--- 模拟朋友发来两条微信消息 ---\n');

  const rounds = ['你好，在忙吗', '那晚上一起吃饭？'];
  let lastSeen = 0;
  for (const text of rounds) {
    console.log(`  「朋友」→ ${text}`);
    await postJson(`http://127.0.0.1:${HOOK_PORT}/debug/incoming`, { wxid: 'wxid_demo_friend', content: text });

    const sent = await waitFor(async () => {
      const r = await getJson(`http://127.0.0.1:${HOOK_PORT}/debug/sent`);
      return r.count > lastSeen ? r : null;
    });
    if (sent) {
      for (const m of sent.sent.slice(lastSeen)) console.log(`  「我」  → ${m.msg}`);
      lastSeen = sent.count;
    } else {
      console.log('  （没有等到回复，看上面的日志）');
    }
    console.log('');
  }

  const ai = await getJson(`http://127.0.0.1:${AI_PORT + 1}/`);
  console.log('--- 说明 ---');
  console.log(`  模型被调用 ${ai.count} 次；第二轮请求携带的上下文轮数：${ai.calls.at(-1)?.turns ?? 0} 条消息`);
  console.log('  这条链路是真的：微信消息 → 归一化 → 触发判断 → 调模型 → 清洗 → 发回微信');
  console.log('  换成真 DLL 和真 API Key 时，代码一行都不用改\n');

  cleanup();
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(0);
}

process.on('SIGINT', () => {
  cleanup();
  process.exit(0);
});

main().catch((err) => {
  console.error('演示失败:', err.message);
  cleanup();
  process.exit(1);
});
