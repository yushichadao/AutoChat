import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { diagnose, checkChatAvailability, effectivePollChats } from '../src/tasks/doctor.js';

function tmpRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-doc-'));
  return dir;
}

test('diagnose 默认只做基础设施体检，不含群可用性（HI4）', async () => {
  const root = tmpRoot();
  try {
    const { items } = await diagnose({ rootDir: root });
    const names = items.map((i) => i.name);
    assert.ok(!names.includes('收消息'), 'diagnose 不应含「收消息」群可用性项');
    assert.ok(!names.includes('小号检查'), 'diagnose 不应含「小号检查」');
    assert.ok(!names.some((n) => String(n).startsWith('会话 ')), 'diagnose 不应含逐群表可达项');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('diagnose scope=chats 委托给群可用性检查（HI4/HI5）', async () => {
  const root = tmpRoot();
  try {
    const res = await diagnose({ rootDir: root, scope: 'chats' });
    const names = res.items.map((i) => i.name);
    assert.ok(names.includes('hook 服务'), 'chats 范围应至少含 hook 服务连通性');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('checkChatAvailability 独立可调用且不自动发现群（HI6）', async () => {
  const root = tmpRoot();
  try {
    // 不写任何配置：effectivePollChats 应为空，检查不应因「自动扫描群表」而报错
    const cfg = { wechat: { pollChats: [] }, chats: {} };
    assert.deepEqual(effectivePollChats(cfg), [], '监听并集来自显式配置，不含自动发现');
    const res = await checkChatAvailability({ rootDir: root });
    assert.ok(Array.isArray(res.items));
    assert.ok(res.items.some((i) => i.name === 'hook 服务'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
