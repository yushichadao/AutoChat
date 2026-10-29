import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pickModelTier, isLongTask, longTaskLabel } from '../src/ai/router.js';
import { loadConfig } from '../src/core/config.js';
import { AIReply } from '../src/ai/replier.js';
import { Responder } from '../src/ai/responder.js';
import { ChatProfiles } from '../src/core/chats.js';

const stubLogger = { info() {}, warn() {}, debug() {}, error() {} };

function makeReplier(cfgExtra = {}, chats = {}) {
  const cfg = {
    model: 'main-model', baseUrl: 'http://main', apiKey: 'k',
    groupReply: 'mention', maxPerHour: 120, cooldownMs: 0, maxConcurrent: 2,
    maxReplyChars: 900, stripMarkdown: true, enabled: true,
    ...cfgExtra,
  };
  return new AIReply({
    cfg,
    // 真实场景传入的是 AIClient，aiConfig / defaultAI 都取自它，故桩要带 baseUrl/model
    ai: { baseUrl: 'http://main', model: 'main-model', apiKey: 'k', chat: async () => ({ text: '' }) },
    logger: stubLogger,
    profiles: new ChatProfiles({ chats }),
  });
}

// ── 路由规则：纯规则判定，不额外调模型 ──────────────────────────────

test('路由：简单问答 → 轻量模型', () => {
  assert.equal(pickModelTier({ text: '你好' }).tier, 'light');
  assert.equal(pickModelTier({ text: '今天天气不错' }).tier, 'light');
});

test('路由：复杂任务 → 主模型（标记 / 长文本 / 附件 / 联网 / 工具）', () => {
  assert.equal(pickModelTier({ text: '帮我分析这个方案' }).tier, 'main');
  assert.equal(pickModelTier({ text: 'a'.repeat(300) }).tier, 'main');
  assert.equal(pickModelTier({ text: '你好', hasAttachment: true }).tier, 'main');
  assert.equal(pickModelTier({ text: '你好', willSearch: true }).tier, 'main');
  assert.equal(pickModelTier({ text: '你好', toolsOn: true }).tier, 'main');
});

// ── 「慢 ≠ 用工具」：生成型任务不依赖工具，但本身就慢（用户 2026-10-27 指出）──

test('生成型任务（写代码 / 长文）不用工具也算复杂 → 主模型', () => {
  assert.equal(pickModelTier({ text: '用 python 写个快排' }).tier, 'main');
  assert.equal(pickModelTier({ text: '帮我实现这个函数' }).tier, 'main');
  assert.equal(pickModelTier({ text: 'write a function to sort' }).tier, 'main');
  assert.equal(pickModelTier({ text: '写一篇关于本地部署的文章' }).tier, 'main');
});

test('生成型任务也发长任务提示（即便不调工具、不联网）', () => {
  assert.equal(longTaskLabel({ text: '写个脚本处理日志' }), '正在编写代码……');
  assert.equal(longTaskLabel({ text: '写一篇总结报告' }), '正在撰写……');
  assert.equal(isLongTask({ text: '用 python 写个快排' }), true);
  // 纯闲聊仍不算长任务，不发多余消息
  assert.equal(isLongTask({ text: '你好' }), false);
});

// ── 默认值锁定：路由默认关（一个模型）/ 长任务提示默认开（B 方案）──────

test('默认：路由关（始终一个模型）+ 长任务提示开（B 方案）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autochat-cfg-'));
  const cfg = loadConfig({ env: {}, rootDir: dir });
  assert.equal(cfg.ai.modelRouting, false, '路由默认关＝始终用用户配的那一个模型');
  assert.equal(cfg.ai.longTaskNotice, true, '长任务提示默认开＝判定为长任务就先告知');
});

// ── 默认一个模型：未开路由时第二模型完全不参与 ──────────────────────

test('默认关闭路由：未配置时 modelRouting 为假，始终用主模型', () => {
  const r = makeReplier({ lightModel: 'fast-model' });
  assert.ok(!r.cfg.modelRouting, '未配置即关闭路由');
  // 即便配了轻量模型，常规路径仍是主模型
  assert.equal(r.aiForChat({}).model, 'main-model');
});

// ── 第二模型由用户指定 ──────────────────────────────────────────────

test('未配 AI_LIGHT_MODEL → aiForLight 返回 null（回落主模型，不打空 endpoint）', () => {
  const r = makeReplier({});
  assert.equal(r.aiForLight({}), null);
});

test('配了轻量模型 → 用它；会话可覆盖（全局/会话两级）', () => {
  const r = makeReplier({ lightModel: 'global-fast', lightBaseUrl: 'http://fast' });
  assert.equal(r.aiForLight({}).model, 'global-fast');
  // AIClient 会把 baseUrl 规范化（补 /v1），故只断言用的是用户指定的那个地址
  assert.ok(String(r.aiForLight({}).baseUrl).startsWith('http://fast'));

  const r2 = makeReplier({ lightModel: 'global-fast' }, { 'c@chatroom': { lightModel: 'chat-fast' } });
  const ovr = r2.profiles.get('c@chatroom');
  assert.equal(ovr.lightModel, 'chat-fast');
  assert.equal(r2.aiForLight(ovr).model, 'chat-fast');
});

test('会话级路由开关覆盖全局', () => {
  const r = makeReplier({}, { 'c@chatroom': { modelRouting: true, longTaskNotice: true } });
  const ovr = r.profiles.get('c@chatroom');
  assert.equal(ovr.modelRouting, true);
  assert.equal(ovr.longTaskNotice, true);
  // 未配置的会话沿用全局（undefined）
  assert.equal(r.profiles.get('other@chatroom').modelRouting, undefined);
});

// ── 长任务：先发提示，结果另起一条新消息（微信无法原地替换）─────────

test('长任务提示文案按场景区分', () => {
  assert.equal(longTaskLabel({ hasAttachment: true }), '正在解析文件……');
  assert.equal(longTaskLabel({ willSearch: true }), '正在联网检索……');
  assert.equal(longTaskLabel({ toolsOn: true }), '正在处理……');
  assert.equal(isLongTask({}), false);
  assert.equal(isLongTask({ willSearch: true }), true);
});

test('工具调用：区分瞬时小工具与真重活（不看字数，看语义标记）', () => {
  // 无文本可判（纯图片 / 语音）时按重活处理，宁可多提示一次也别让用户干等
  assert.equal(longTaskLabel({ toolsOn: true }), '正在处理……');
  // 瞬时小工具：短且无任何重活标记 → 不弹占位（否则每条「现在几点」都提示，很烦）
  assert.equal(longTaskLabel({ toolsOn: true, text: '现在几点' }), '');
  assert.equal(longTaskLabel({ toolsOn: true, text: '算下 12*15' }), '');
  // 短但明显是重活：不能因为字数少就漏掉提示（「生成一份报告发我」只有 8 字，却要真写一份 docx）
  assert.equal(longTaskLabel({ toolsOn: true, text: '生成一份报告发我' }), '正在处理……');
  assert.equal(longTaskLabel({ toolsOn: true, text: '写个快排' }), '正在处理……');
  // 够长的文本即便没命中标记，也按重活处理
  assert.equal(longTaskLabel({ toolsOn: true, text: '帮我查一下这周群里都聊了些什么内容' }), '正在处理……');
});

test('长任务：提示与结果各占一条消息，顺序为「提示 → 结果」', async () => {
  const sent = [];
  const hook = { sendText: async (to, text) => { sent.push(text); return { ok: true }; } };
  const resp = new Responder({
    ai: { chat: async () => ({ text: '' }) },
    cfg: { maxReplyChars: 900, stripMarkdown: true },
    hook,
    logger: stubLogger,
  });

  await resp.sendNotice('c', '正在解析文件……');
  await resp.deliver('c', '这是最终结果');

  assert.equal(sent.length, 2, '提示一条 + 结果一条，共两条真消息');
  assert.equal(sent[0], '正在解析文件……');
  assert.equal(sent[1], '这是最终结果');
});
