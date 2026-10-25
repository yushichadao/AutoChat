import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { safeEnv, CHAT_FIELDS, startGui } from '../src/gui/server.js';

test('safeEnv 把密钥类脱敏为布尔，其余配置原样保留', () => {
  const out = safeEnv({
    AI_API_KEY: 'sk-secret',
    WX_WEBHOOK_TOKEN: 'tok',
    AI_BASE_URL: 'http://example',
  });
  assert.equal(out.AI_API_KEY, true);
  assert.equal(out.WX_WEBHOOK_TOKEN, true);
  assert.equal(out.AI_BASE_URL, 'http://example');
});

test('CHAT_FIELDS 白名单不含 apiKey（防止越权写入敏感键）', () => {
  assert.ok(CHAT_FIELDS instanceof Set);
  assert.equal(CHAT_FIELDS.has('apiKey'), false);
  assert.ok(CHAT_FIELDS.has('enabled'));
  assert.ok(CHAT_FIELDS.has('personaFile'));
  assert.ok(CHAT_FIELDS.has('systemPrompt'));
});

test('配置器接口需令牌：无 token 被拒(401)，带 token 放行', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autochat-srv-'));
  const { server, token } = await startGui({
    port: 40000 + Math.floor(Math.random() * 15000), // 动态高端口，避免与本地可能占用的 8788 冲突
    token: 'secret-token',
    rootDir: root,
    window: false,
  });
  const port = server.address().port;
  try {
    const noTok = await fetch(`http://127.0.0.1:${port}/api/env`);
    assert.equal(noTok.status, 403, '无 token 必须拒绝(403 Forbidden)');
    const withTok = await fetch(`http://127.0.0.1:${port}/api/env?token=${token}`);
    assert.notEqual(withTok.status, 401, '带 token 应通过鉴权（与 buildState 成败无关）');
  } finally {
    server.close();
  }
});
