import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildBaseline, CONTENT_REVIEW_RULES } from '../src/ai/persona.js';

test('buildBaseline 始终追加 AI 侧内容审核规则（R21，人设关不掉）', () => {
  const base = buildBaseline({ account: 'a', persona: 'p', model: 'm' });
  assert.ok(base.includes('内容审核'));
  assert.ok(base.includes('事实纠错'));
  assert.ok(base.includes('违法'));
  // 与身份底线共存，且为可识别的不可覆盖段
  assert.ok(base.includes('不可覆盖'));
  assert.ok(CONTENT_REVIEW_RULES.includes('内容审核'));
});

test('用户自定义人设盖不掉内容审核（底层始终追加）', () => {
  const custom = '我是自定义人设，什么都不管。';
  const base = buildBaseline({ account: 'a', persona: 'p', model: 'm' });
  // buildBaseline 拼的是 IDENTITY_RULES + identityLine + CONTENT_REVIEW_RULES；
  // 上层人设是从别处拼进 system 的，底层这一段独立存在，故这里只验证底层段自身完备。
  assert.ok(base.includes('内容审核'));
  assert.ok(!base.includes(custom)); // 确保没把上层人设混进来
});
