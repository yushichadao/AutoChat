import { test } from 'node:test';
import assert from 'node:assert/strict';
import { effectivePollChats } from '../src/tasks/doctor.js';

test('effectivePollChats 按 currentWxid 隔离旧号专属群（换号防误监听/误回复）', () => {
  const cfg = {
    wechat: { pollChats: [], selfId: 'wxidB' },
    chats: {
      'g@chatroom': { enabled: true },
      'a_only@chatroom': { enabled: true, account: 'wxidA' },
      'b_only@chatroom': { enabled: true, account: 'wxidB' },
      'off@chatroom': { enabled: false, account: 'wxidB' },
    },
  };
  const forB = effectivePollChats(cfg, 'wxidB');
  assert.ok(forB.includes('g@chatroom'), '全局群应监听');
  assert.ok(forB.includes('b_only@chatroom'), '本号专属群应监听');
  assert.ok(!forB.includes('a_only@chatroom'), '旧号专属群不应被 B 监听（跨库误回复风险）');
  assert.ok(!forB.includes('off@chatroom'), '禁用群不应监听');

  const forA = effectivePollChats(cfg, 'wxidA');
  assert.ok(forA.includes('a_only@chatroom'), 'A 号专属群应监听');
  assert.ok(!forA.includes('b_only@chatroom'), 'B 号专属群不应被 A 监听');

  // 不传 currentWxid（兼容旧调用）：返回所有启用群（含带 account 字段的）
  const any = effectivePollChats(cfg);
  assert.ok(any.includes('a_only@chatroom'));
  assert.ok(any.includes('b_only@chatroom'));
  assert.ok(!any.includes('off@chatroom'));
});
