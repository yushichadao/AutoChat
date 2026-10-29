import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * 插件侧的最小回归：DSH 组合包的「协议面」与「门槛」是否成立。
 *
 * 只测不碰系统的那一层：
 *   · 组合包清单（package.json 的 dsh.bundle.patch、cordis.patch.yml 的插入行）
 *   · 工具清单是否覆盖根本性配置的全部入口
 *   · MCP 传输层：握手、tools/list、未知工具/未知方法
 *   · 写操作没有 confirm 时必须被拦（而且不能真的执行）
 * 需要真实微信环境的工具（preflight/doctor/service）放在手工冒烟里跑。
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const BUNDLE = path.join(ROOT, 'plugin', 'dsh-autochat');
const SERVER = path.join(ROOT, 'src', 'mcp', 'server.js');
/** Windows 上动态 import 必须给 file:// URL，绝对路径会报 ERR_UNSUPPORTED_ESM_URL_SCHEME。 */
const importTools = () => import(pathToFileURL(path.join(BUNDLE, 'lib', 'tools.js')).href);

/** 起一个 MCP 服务器，返回 {rpc, close}。 */
function startServer() {
  const child = spawn(process.execPath, [SERVER], { cwd: ROOT, windowsHide: true });
  const pending = new Map();
  let buf = '';
  let seq = 0;

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      const waiting = pending.get(msg.id);
      if (waiting) {
        pending.delete(msg.id);
        waiting(msg);
      }
    }
  });

  const rpc = (method, params) =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, resolve);
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      setTimeout(() => reject(new Error('MCP 响应超时：' + method)), 30000);
    });

  const close = () => {
    try {
      child.stdin.end();
      child.kill();
    } catch {
      /* 已经退了 */
    }
  };

  return { rpc, close };
}

test('DSH 组合包：清单声明了 bundle patch，且 patch 指向本包', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(BUNDLE, 'package.json'), 'utf8'));
  assert.equal(pkg.name, 'dsh-autochat');
  assert.ok(pkg.version);
  assert.equal(pkg.type, 'module');
  assert.equal(pkg.main, 'index.js');

  const patchFile = pkg.dsh && pkg.dsh.bundle && pkg.dsh.bundle.patch;
  assert.equal(patchFile, './cordis.patch.yml');
  assert.ok(fs.existsSync(path.join(BUNDLE, 'cordis.patch.yml')), 'cordis.patch.yml 必须存在');

  // 插入行按包名引用插件代码，模块解析才找得到
  const patch = fs.readFileSync(path.join(BUNDLE, 'cordis.patch.yml'), 'utf8');
  assert.match(patch, /- insert:/);
  assert.match(patch, /id:\s*autochat/);
  assert.match(patch, /name:\s*dsh-autochat/);

  // 组合包随包发布的东西都要在 files 里
  for (const f of ['index.js', 'lib/', 'assets/', 'cordis.patch.yml']) {
    assert.ok(pkg.files.includes(f), 'files 缺少 ' + f);
  }
});

test('DSH 插件入口：导出 cordis 插件名、服务依赖与 apply', () => {
  const src = fs.readFileSync(path.join(BUNDLE, 'index.js'), 'utf8');
  assert.match(src, /export const name = 'autochat'/);
  assert.match(src, /export const inject = \['tools', 'skills'\]/);
  assert.match(src, /export function apply\(ctx, config\)/);
  assert.match(src, /ctx\.tools\.register\(/);
  assert.match(src, /ctx\.skills\.registerProvider\(/);
});

test('工具层：覆盖根本性配置的全部入口，且每个工具都有参数说明', async () => {
  const { TOOL_SPECS } = await importTools();
  const names = TOOL_SPECS.map((t) => t.name);
  for (const need of [
    'autochat_preflight',
    'autochat_doctor',
    'autochat_status',
    'autochat_service',
    'autochat_reply_gate',
    'autochat_config',
    'autochat_chats',
    'autochat_apply_step',
    'autochat_model',
    'autochat_logs',
  ]) {
    assert.ok(names.includes(need), '缺少工具 ' + need);
  }
  for (const t of TOOL_SPECS) {
    assert.ok(t.description && t.description.length > 10, t.name + ' 缺少说明');
    assert.equal(typeof t.parameters, 'object', t.name + ' 缺少参数定义');
  }
});

test('MCP：握手返回工具能力与服务器标识', async () => {
  const { rpc, close } = startServer();
  try {
    const r = await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' } });
    assert.equal(r.result.serverInfo.name, 'autochat');
    assert.ok(r.result.capabilities.tools, '应该声明 tools 能力');
    assert.match(r.result.instructions, /preflight/);
  } finally {
    close();
  }
});

test('MCP：tools/list 与工具层保持一致', async () => {
  const { TOOL_SPECS } = await importTools();
  const { rpc, close } = startServer();
  try {
    const r = await rpc('tools/list', {});
    const names = r.result.tools.map((t) => t.name).sort();
    assert.deepEqual(names, TOOL_SPECS.map((t) => t.name).sort());
    for (const t of r.result.tools) {
      assert.equal(t.inputSchema.type, 'object', t.name + ' 的 inputSchema 不合法');
    }
  } finally {
    close();
  }
});

test('MCP：动系统/微信目录的步骤没有 confirm 时必须被拦下', async () => {
  const { rpc, close } = startServer();
  try {
    const r = await rpc('tools/call', { name: 'autochat_apply_step', arguments: { step: 'deploy-dll' } });
    assert.equal(r.result.isError, true, '没有 confirm 不该放行');
    assert.match(r.result.content[0].text, /confirm/);
  } finally {
    close();
  }
});

test('MCP：写 .env 没有 confirm 时必须被拦下', async () => {
  const { rpc, close } = startServer();
  try {
    const r = await rpc('tools/call', {
      name: 'autochat_config',
      arguments: { action: 'set', key: 'AI_MODEL', value: 'x' },
    });
    assert.equal(r.result.isError, true);
    assert.match(r.result.content[0].text, /confirm/);
  } finally {
    close();
  }
});

test('MCP：未知工具/未知方法按 JSON-RPC 报错，不让客户端干等', async () => {
  const { rpc, close } = startServer();
  try {
    const bad = await rpc('tools/call', { name: 'no-such-tool', arguments: {} });
    assert.equal(bad.error.code, -32602);

    const badMethod = await rpc('no/such/method', {});
    assert.equal(badMethod.error.code, -32601);
  } finally {
    close();
  }
});

test('技能：正文随包发布，说明里写明「七步不可跳」', () => {
  const body = fs.readFileSync(path.join(BUNDLE, 'assets', 'autochat-console.md'), 'utf8');
  assert.match(body, /根本性配置/);
  assert.match(body, /autochat_preflight/);
  assert.match(body, /绝不|不可跳/);
});
