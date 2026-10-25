import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ChatProfiles } from '../src/core/chats.js';

test('未配置的会话返回空覆盖项', () => {
  const p = new ChatProfiles({ chats: {} });
  const o = p.get('nobody');
  assert.equal(o.enabled, undefined);
  assert.equal(o.groupReply, undefined);
  assert.equal(p.size, 0);
});

test('按会话读出 enabled / groupReply / triggerPrefix', () => {
  const p = new ChatProfiles({
    chats: {
      'a@chatroom': { enabled: false, groupReply: 'always', triggerPrefix: '小助手' },
      'b@chatroom': { enabled: true },
    },
  });
  assert.equal(p.size, 2);
  assert.deepEqual(p.ids(), ['a@chatroom', 'b@chatroom']);
  assert.equal(p.get('a@chatroom').enabled, false);
  assert.equal(p.get('a@chatroom').groupReply, 'always');
  assert.equal(p.get('a@chatroom').triggerPrefix, '小助手');
  assert.equal(p.get('b@chatroom').enabled, true);
});

test('会话专属人设优先于全局；文件读不到就退回全局', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'autochat-persona-'));
  const file = path.join(tmp, 'p.md');
  fs.writeFileSync(file, '你是群里的技术答疑机器人。', 'utf8');

  const p = new ChatProfiles({ chats: { 'g@chatroom': { personaFile: file } }, rootDir: tmp });
  assert.equal(p.persona('g@chatroom', '全局人设'), '你是群里的技术答疑机器人。');
  assert.equal(p.persona('other@chatroom', '全局人设'), '全局人设');

  // 文件不存在时退回全局，不抛异常
  const p2 = new ChatProfiles({ chats: { 'x@chatroom': { personaFile: path.join(tmp, 'nope.md') } }, rootDir: tmp });
  assert.equal(p2.persona('x@chatroom', '全局人设'), '全局人设');

  fs.rmSync(tmp, { recursive: true, force: true });
});

test('内联 systemPrompt 也可作为会话人设', () => {
  const p = new ChatProfiles({ chats: { 'g@chatroom': { systemPrompt: '只聊天气' } } });
  assert.equal(p.persona('g@chatroom', '全局'), '只聊天气');
});
