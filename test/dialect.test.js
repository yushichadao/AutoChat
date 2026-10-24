import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { HookClient } from '../src/bridge/hook-client.js';
import { DialectStore, TEXT_DIALECTS, orderByLearned } from '../src/bridge/dialect.js';

const silence = { debug() {}, info() {}, warn() {}, error() {} };

/** 起一个假 DLL：只接受指定路径 + 指定字段组合。 */
async function fakeDll({ acceptPath, acceptFields, reply }) {
  const calls = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      const body = text ? JSON.parse(text) : {};
      calls.push({ path: req.url, body });

      if (req.url !== acceptPath) {
        res.writeHead(404).end('not found');
        return;
      }
      const ok = acceptFields.every((f) => body[f] !== undefined);
      const payload = reply ? reply(ok, body) : ok ? { ret: 0 } : { ret: 1, retmsg: 'bad params' };
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(payload));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, calls, port: server.address().port };
}

function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autochat-dialect-'));
  return { store: new DialectStore(path.join(dir, 'dialect.json'), silence), dir };
}

test('标准 wechat-hook 方言：一次命中', async () => {
  const dll = await fakeDll({ acceptPath: '/SendTextMsg', acceptFields: ['wxidorgid', 'msg'] });
  const { store } = tmpStore();
  const client = new HookClient({ host: '127.0.0.1', port: dll.port, endpoints: { sendText: '/SendTextMsg' }, logger: silence, dialect: store });

  const res = await client.sendText('wxid_a', 'hi');
  assert.equal(res.ok, true);
  assert.equal(dll.calls.length, 1);
  assert.equal(store.get('text').dialect, 'wxidorgid+msg');
  dll.server.close();
});

test('别家方言（wxid+content @ /send_text）能被自动学出来', async () => {
  const dll = await fakeDll({ acceptPath: '/send_text', acceptFields: ['wxid', 'content'] });
  const { store } = tmpStore();
  const client = new HookClient({ host: '127.0.0.1', port: dll.port, endpoints: { sendText: '/SendTextMsg' }, logger: silence, dialect: store });

  const res = await client.sendText('wxid_b', 'hello');
  assert.equal(res.ok, true);
  assert.deepEqual(store.get('text'), { dialect: 'wxid+content', path: '/send_text' });
  dll.server.close();
});

test('学会之后第二次直接命中，不再逐个试', async () => {
  const dll = await fakeDll({ acceptPath: '/send_text', acceptFields: ['wxid', 'content'] });
  const { store } = tmpStore();
  const client = new HookClient({ host: '127.0.0.1', port: dll.port, endpoints: { sendText: '/SendTextMsg' }, logger: silence, dialect: store });

  await client.sendText('wxid_c', 'first');
  const afterFirst = dll.calls.length;
  await client.sendText('wxid_c', 'second');

  assert.equal(dll.calls.length - afterFirst, 1, '第二次应该只发一个请求');
  assert.equal(dll.calls.at(-1).body.content, 'second');
  dll.server.close();
});

test('to+text 方言同样能命中', async () => {
  const dll = await fakeDll({ acceptPath: '/api/sendText', acceptFields: ['to', 'text'] });
  const { store } = tmpStore();
  const client = new HookClient({ host: '127.0.0.1', port: dll.port, endpoints: { sendText: '/SendTextMsg' }, logger: silence, dialect: store });

  const res = await client.sendText('wxid_d', 'yo');
  assert.equal(res.ok, true);
  assert.deepEqual(store.get('text'), { dialect: 'to+text', path: '/api/sendText' });
  dll.server.close();
});

test('所有方言都失败时返回失败而不是抛错', async () => {
  const dll = await fakeDll({ acceptPath: '/SendTextMsg', acceptFields: ['不存在的字段'] });
  const { store } = tmpStore();
  const client = new HookClient({ host: '127.0.0.1', port: dll.port, endpoints: { sendText: '/SendTextMsg' }, logger: silence, dialect: store });

  const res = await client.sendText('wxid_e', 'x');
  assert.equal(res.ok, false);
  assert.ok(res.message);
  dll.server.close();
});

test('非标准成功标志（code=0）也认', async () => {
  const dll = await fakeDll({ acceptPath: '/SendTextMsg', acceptFields: ['wxidorgid'], reply: () => ({ code: 0, message: 'ok' }) });
  const { store } = tmpStore();
  const client = new HookClient({ host: '127.0.0.1', port: dll.port, endpoints: { sendText: '/SendTextMsg' }, logger: silence, dialect: store });

  const res = await client.sendText('wxid_f', 'x');
  assert.equal(res.ok, true);
  dll.server.close();
});

test('空响应体按成功处理，避免重复发送', async () => {
  const dll = await fakeDll({ acceptPath: '/SendTextMsg', acceptFields: ['wxidorgid'], reply: () => null });
  const { store } = tmpStore();
  const client = new HookClient({ host: '127.0.0.1', port: dll.port, endpoints: { sendText: '/SendTextMsg' }, logger: silence, dialect: store });

  const res = await client.sendText('wxid_g', 'x');
  assert.equal(res.ok, true);
  assert.equal(dll.calls.length, 1);
  dll.server.close();
});

test('orderByLearned 把命中项提前且不改变原数组', () => {
  const original = TEXT_DIALECTS.slice();
  const ordered = orderByLearned(TEXT_DIALECTS, 'to+text');
  assert.equal(ordered[0].name, 'to+text');
  assert.equal(TEXT_DIALECTS[0].name, original[0].name);
  assert.equal(orderByLearned(TEXT_DIALECTS, null), TEXT_DIALECTS);
});
