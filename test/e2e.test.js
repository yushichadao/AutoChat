import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startWithPort, startPlain, waitPort, killAll, poll, getJson, postJson } from './helpers.js';

/**
 * 端到端用例。
 *
 * 约定：
 *  - 所有服务都用随机端口（--port 0），避免撞上残留进程导致读到错误的服务
 *  - 每个子进程退出码非 0 立即让用例失败，不静默等超时
 *  - 用例结束同步杀干净，不留残余进程
 */

/** 起一套「假 hook + 假模型 + 助手」，返回各端口与调用记录读取器。 */
async function boot(t, { env = {}, config = {}, hookArgs = [] } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'autochat-e2e-'));
  const cfgFile = path.join(tmp, 'config.json');
  fs.writeFileSync(cfgFile, JSON.stringify(config));

  const children = [];
  t.after(() => {
    killAll(children);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const WH = await freePort();
  const ai = await startWithPort(['tools/mock-ai.js', '--port', '0']);
  children.push(ai.child);
  const hook = await startWithPort([
    'tools/mock-hook.js',
    '--port',
    '0',
    '--webhook',
    `http://127.0.0.1:${WH}/wechat`,
    ...hookArgs,
  ]);
  children.push(hook.child);

  const gw = startPlain(['src/index.js'], {
    WX_SKIP_INJECT: '1',
    WX_HOOK_PORT: String(hook.port),
    WX_WEBHOOK_PORT: String(WH),
    WX_RECEIVE_MODE: 'webhook',
    WX_CONFIG_FILE: cfgFile,
    WX_ENV_FILE: path.join(tmp, 'no.env'),
    WX_DATA_DIR: tmp,
    AI_ENABLED: '1',
    AI_BASE_URL: `http://127.0.0.1:${ai.port}/v1`,
    AI_API_KEY: 'test-key',
    AI_MODEL: 'hy3',
    AI_COOLDOWN_MS: '0',
    ...env,
  });
  children.push(gw);

  await waitPort(WH, 20000);
  await new Promise((r) => setTimeout(r, 400));

  return {
    tmp,
    hookPort: hook.port,
    aiPort: ai.port,
    webhookPort: WH,
    aiCalls: async () => getJson(`http://127.0.0.1:${ai.port + 1}/`),
    sent: async () => getJson(`http://127.0.0.1:${hook.port}/debug/sent`),
    incoming: (body) => postJson(`http://127.0.0.1:${hook.port}/debug/incoming`, body),
    resetSent: () => postJson(`http://127.0.0.1:${hook.port}/debug/reset`),
  };
}

test('端到端：微信来消息 → 调模型 → 回微信', async (t) => {
  const b = await boot(t);

  await b.incoming({ wxid: 'wxid_ai_user', content: '你好呀' });

  const sent = await poll(async () => {
    const r = await b.sent();
    return r.count > 0 ? r : null;
  }, 15000);
  assert.ok(sent, 'AI 没有回复到微信');
  assert.equal(sent.sent[0].to, 'wxid_ai_user');
  assert.match(sent.sent[0].msg, /收到：你好呀/, '应该是 mock 模型对用户消息的回复');

  const calls = await b.aiCalls();
  assert.equal(calls.count, 1, `模型只应被调用 1 次，实际 ${calls.count} 次`);
  assert.equal(calls.calls[0].model, 'hy3', '模型名应该按配置传过去');
  // 第二轮要带上历史，证明上下文确实带上了
  await b.incoming({ wxid: 'wxid_ai_user', content: '继续' });
  await poll(async () => {
    const r = await b.aiCalls();
    return r.count >= 2 ? r : null;
  }, 15000);
  const calls2 = await b.aiCalls();
  assert.ok(calls2.calls[1].turns >= 3, '第二次调用应当带上历史上下文');
});

test('端到端：别家方言的 DLL 也能自己学会', async (t) => {
  const b = await boot(t, {
    hookArgs: ['--dialect', 'wxid+content', '--textPath', '/send_text'],
  });

  await b.incoming({ wxid: 'wxid_target', content: '方言测试' });

  const sent = await poll(async () => {
    const r = await b.sent();
    return r.count > 0 ? r : null;
  }, 15000);
  assert.ok(sent, '未能通过非标准方言发出消息');
  assert.equal(sent.sent[0].msg, '收到：方言测试');
  assert.equal(sent.sent[0].dialect, 'wxid+content', '应该学到别家的字段名');
});

test('端到端：自己发出去的消息不会被当成提问（防自问自答）', async (t) => {
  const b = await boot(t, { env: { WX_SELF_ID: 'wxid_self_mock' } });

  // 1) 自己发的消息（sender 就是本机 wxid）→ 必须被丢弃，不能触发模型
  await b.incoming({ wxid: 'wxid_self_mock', content: '这是我自己发出去的消息' });

  // 2) 正常提问 → 应该被回复
  await b.incoming({ wxid: 'wxid_other', content: '在吗' });
  const sent = await poll(async () => {
    const r = await b.sent();
    return r.count > 0 ? r : null;
  }, 15000);
  assert.ok(sent, '正常提问应该被回复');

  // 3) 把刚才 AI 发的内容再推回来一次（模拟 hook 把自己发的消息回调回来）
  await b.incoming({ wxid: 'wxid_other', content: sent.sent[0].msg });
  await new Promise((r) => setTimeout(r, 1200));

  const calls = await b.aiCalls();
  assert.equal(calls.count, 1, `模型只应被调用 1 次，实际 ${calls.count} 次（自身回声被误当成提问）`);
});

test('端到端：webhook 开启 token 校验后拒绝无凭据的请求', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'autochat-token-'));
  const cfgFile = path.join(tmp, 'config.json');
  fs.writeFileSync(cfgFile, JSON.stringify({ chats: {} }));

  const children = [];
  t.after(() => {
    killAll(children);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const WH = await freePort();
  const hook = await startWithPort([
    'tools/mock-hook.js',
    '--port',
    '0',
    '--webhook',
    `http://127.0.0.1:${WH}/wechat?token=s3cret`,
  ]);
  children.push(hook.child);

  const gw = startPlain(['src/index.js'], {
    WX_SKIP_INJECT: '1',
    WX_HOOK_PORT: String(hook.port),
    WX_WEBHOOK_PORT: String(WH),
    WX_RECEIVE_MODE: 'webhook',
    WX_WEBHOOK_TOKEN: 's3cret',
    WX_CONFIG_FILE: cfgFile,
    WX_ENV_FILE: path.join(tmp, 'no.env'),
    WX_DATA_DIR: tmp,
  });
  children.push(gw);

  await waitPort(WH, 20000);

  // 无 token → 401
  const noToken = await fetch(`http://127.0.0.1:${WH}/wechat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ wxid: 'wxid_x', content: 'hi' }),
  });
  assert.equal(noToken.status, 401, '没有 token 的请求应当被拒绝');

  // 带 token → 200
  const withToken = await fetch(`http://127.0.0.1:${WH}/wechat?token=s3cret`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ wxid: 'wxid_x', content: 'hi' }),
  });
  assert.equal(withToken.status, 200, '带 token 的请求应当被接受');
});

test('端到端：按会话配置生效（可停用 / 可改群策略 / 可换人设）', async (t) => {
  const b = await boot(t, {
    config: {
      chats: {
        'quiet@chatroom': { enabled: false },
        'loud@chatroom': { groupReply: 'always' },
      },
    },
  });

  // 1) 停用的群 → 一条都不回
  await b.incoming({ wxid: 'wxid_m1', roomid: 'quiet@chatroom', content: '有人吗' });
  await new Promise((r) => setTimeout(r, 1200));
  let calls = await b.aiCalls();
  assert.equal(calls.count, 0, '停用的会话不应触发模型');

  // 2) groupReply=always 的群 → 不用 @ 也回
  await b.incoming({ wxid: 'wxid_m2', roomid: 'loud@chatroom', content: '随便聊聊' });
  const sent = await poll(async () => {
    const r = await b.sent();
    return r.count > 0 ? r : null;
  }, 15000);
  assert.ok(sent, 'always 策略的群应当直接回复');

  // 3) 默认策略的群 → 不 @ 不回
  await b.incoming({ wxid: 'wxid_m3', roomid: 'normal@chatroom', content: '随便聊聊' });
  await new Promise((r) => setTimeout(r, 1200));
  calls = await b.aiCalls();
  assert.equal(calls.count, 1, '默认 mention 策略下，未被 @ 的群消息不应触发模型');
});

/** 拿一个当前空闲的端口（先占再放，极小概率与随后监听冲突）。 */
async function freePort() {
  const net = await import('node:net');
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}
