import test from 'node:test';
import assert from 'node:assert/strict';
import { TriggerPolicy, DEFAULT_REJECT_PATTERNS } from '../src/ai/trigger.js';
import { RateLimiter } from '../src/ai/limiter.js';
import { buildSystemPrompt, buildMessages, DEFAULT_PERSONA } from '../src/ai/prompt.js';

const base = {
  enabled: true,
  groupReply: 'mention',
  privateRequirePrefix: false,
  triggerPrefix: '',
  allowChats: [],
  denyChats: [],
  groupAtNames: [],
  rejectPatterns: [],
};

test('群里 @ 到别人不应触发（结构化 at 可判定时不再用正则兜底）', () => {
  const p = new TriggerPolicy(base);
  const msg = { chatType: 'group', kind: 'text', text: '@小林 你在吗', chatId: 'g', atUsers: ['wxid_other'] };
  assert.equal(p.mentionsUs(msg, 'wxid_self'), false);
});

test('群里 @ 到自己应触发', () => {
  const p = new TriggerPolicy(base);
  const msg = { chatType: 'group', kind: 'text', text: '@我 在吗', chatId: 'g', atUsers: ['wxid_self'] };
  assert.equal(p.mentionsUs(msg, 'wxid_self'), true);
});

test('配置了称呼后只认 @称呼', () => {
  const p = new TriggerPolicy({ ...base, groupAtNames: ['小助手'] });
  assert.equal(p.mentionsUs({ chatType: 'group', kind: 'text', text: '@小助手 在吗', chatId: 'g' }, ''), true);
  assert.equal(p.mentionsUs({ chatType: 'group', kind: 'text', text: '@别人 在吗', chatId: 'g' }, ''), false);
  // 没配置称呼时退回「有 @ 就算」
  const loose = new TriggerPolicy(base);
  assert.equal(loose.mentionsUs({ chatType: 'group', kind: 'text', text: '@任何人', chatId: 'g' }, ''), true);
});

test('否定语义直接拒绝回复', () => {
  const p = new TriggerPolicy(base);
  const d = p.decide({ chatType: 'private', kind: 'text', text: '别回我', chatId: 'a' });
  assert.equal(d.ok, false);
  assert.match(d.reason, /^rejected:/);
  assert.ok(DEFAULT_REJECT_PATTERNS.length > 0);
});

test('非文本不回复', () => {
  const p = new TriggerPolicy(base);
  assert.equal(p.decide({ chatType: 'private', kind: 'image', text: '', chatId: 'a' }).ok, false);
});

test('限流：冷却 / 配额 / 并发三道闸门', () => {
  const lim = new RateLimiter({ cooldownMs: 1000, maxPerHour: 2, maxConcurrent: 1 });
  const msg = { chatId: 'a' };

  assert.equal(lim.check(msg), null);
  lim.begin('a');
  assert.equal(lim.check(msg), 'concurrent', '并发上限应生效');
  lim.end('a');

  lim.mark('a');
  assert.equal(lim.check(msg), 'cooldown', '冷却应生效');

  const lim2 = new RateLimiter({ cooldownMs: 0, maxPerHour: 2, maxConcurrent: 5 });
  lim2.replyTimes = [Date.now(), Date.now()];
  assert.equal(lim2.check(msg), 'quota', '每小时配额应生效');
});

test('prompt 里带上群名与说话人', () => {
  const sys = buildSystemPrompt({
    persona: DEFAULT_PERSONA,
    msg: { chatType: 'group', chatName: '产品交流群', senderName: '小林', senderId: 'wxid_x' },
    cfg: { groupReply: 'mention' },
  });
  assert.match(sys, /产品交流群/);
  assert.match(sys, /小林/);
  assert.match(sys, /别抢着回答/);
});

test('prompt 数组顺序为 system → 历史 → 本轮', () => {
  const msgs = buildMessages({
    persona: 'P',
    msg: { chatType: 'private', chatName: '老王', senderName: '老王', senderId: 'wxid_w' },
    cfg: {},
    history: [{ role: 'user', content: '之前' }],
    userText: '现在',
  });
  assert.equal(msgs[0].role, 'system');
  assert.equal(msgs[1].content, '之前');
  assert.equal(msgs[2].content, '现在');
});

test('默认人设包含「不代替本人做承诺」的护栏', () => {
  assert.match(DEFAULT_PERSONA, /不代替本人做承诺/);
  assert.match(DEFAULT_PERSONA, /验证码/);
});
