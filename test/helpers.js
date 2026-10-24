import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 端口是否可连。 */
export function waitPort(port, timeoutMs = 15000, host = '127.0.0.1') {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      const socket = net.connect({ host, port }, () => {
        socket.destroy();
        resolve(true);
      });
      socket.on('error', () => {
        socket.destroy();
        if (Date.now() > deadline) reject(new Error(`端口 ${port} 未就绪`));
        else setTimeout(tryOnce, 250);
      });
    };
    tryOnce();
  });
}

/**
 * 起一个子进程，等到它打印 PORT=xxx 为止。
 * 用随机端口（--port 0）避免固定端口被别的进程占用，导致测试连到错误的服务
 * （旧实现用固定端口，撞上残留进程时会读到别人的调用记录，出现假红）。
 */
export function startWithPort(args, { env = {}, timeoutMs = 15000, cwd = ROOT } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    let buf = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`子进程 ${args.join(' ')} 未在 ${timeoutMs}ms 内打印端口`));
    }, timeoutMs);

    const onLine = (chunk) => {
      buf += chunk.toString('utf8');
      const m = /PORT=(\d+)/.exec(buf);
      if (m && !settled) {
        settled = true;
        clearTimeout(timer);
        resolve({ child, port: Number(m[1]) });
      }
    };

    child.stdout.on('data', onLine);
    child.stderr.on('data', onLine);
    child.on('exit', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`子进程 ${args.join(' ')} 提前退出（code=${code}）: ${buf.slice(-300)}`));
    });
  });
}

/** 起一个普通子进程（网关）。第二个参数就是追加的环境变量。 */
export function startPlain(args, env = {}) {
  const child = spawn(process.execPath, args, {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  child.stdout.on('data', (d) => process.stdout.write(`    │ ${d}`));
  child.stderr.on('data', (d) => process.stdout.write(`    ! ${d}`));
  return child;
}

/** 同步杀掉子进程树（Windows 用 taskkill /T /F），避免留下残留进程污染后续用例。 */
export function killAll(children) {
  for (const c of children || []) {
    if (!c || !c.pid) continue;
    try {
      spawnSync('taskkill', ['/pid', String(c.pid), '/T', '/F'], { windowsHide: true, timeout: 10000 });
    } catch {
      try {
        c.kill();
      } catch {
        /* ignore */
      }
    }
  }
}

export async function poll(fn, timeoutMs = 12000, interval = 250) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) return null;
    await new Promise((r) => setTimeout(r, interval));
  }
}

export const getJson = async (url) => (await fetch(url)).json();

export const postJson = async (url, body) =>
  (
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    })
  ).json();
