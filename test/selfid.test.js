import http from 'node:http';
import test from 'node:test';
import assert from 'node:assert/strict';
import { HookClient } from '../src/bridge/hook-client.js';

/** 起一个本地 mock hook，handler 在请求体收齐后被调用。 */
function startServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => handler(req, res, body));
    });
    server.listen(0, () => resolve(server));
  });
}

const ep = { selfProfile: '/GetSelfProfile', queryDb: '/QueryDB/execute' };

test('selfProfile 兼容 username / name 字段名（不同 DLL 命名不同）', async () => {
  const server = await startServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ username: 'wxid_abc123', name: '我自己' }));
  });
  const port = server.address().port;
  const hook = new HookClient({ host: '127.0.0.1', port, endpoints: ep });
  try {
    const prof = await hook.selfProfile();
    assert.equal(prof?.wxid, 'wxid_abc123');
    assert.equal(prof?.nickname, '我自己');
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('selfProfile 无 wxid 字段时返回 null', async () => {
  const server = await startServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ret: 1, msg: 'not login' }));
  });
  const port = server.address().port;
  const hook = new HookClient({ host: '127.0.0.1', port, endpoints: ep });
  try {
    assert.equal(await hook.selfProfile(), null);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('selfAccount 在 Message 库为空时从 MicroMsg.db userinfo 兜底', async () => {
  const server = await startServer((req, res, body) => {
    const { optDbName, SQL } = JSON.parse(body || '{}');
    res.setHeader('Content-Type', 'application/json');
    if (optDbName === 'Message') res.end(JSON.stringify({ data: [{ StrAccount: '' }] }));
    else if (SQL.includes('userinfo')) res.end(JSON.stringify({ data: [{ value: 'wxid_userinfo' }] }));
    else res.end(JSON.stringify({ data: [] }));
  });
  const port = server.address().port;
  const hook = new HookClient({ host: '127.0.0.1', port, endpoints: ep, dbQueryTimeoutMs: 2000 });
  try {
    assert.equal(await hook.selfAccount(), 'wxid_userinfo');
  } finally {
    await new Promise((r) => server.close(r));
  }
});
